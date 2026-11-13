#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""量能脉搏 · 本地行情聚合服务

仅使用 Python 标准库。浏览器每 5 秒请求 /api/dashboard，
由本服务合并东方财富的指数、涨跌家数、分时成交额和封板股池数据。
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import mimetypes
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, time as dtime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

BASE_DIR = Path(__file__).resolve().parent
CST = timezone(timedelta(hours=8))
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/142.0.0.0 Safari/537.36"
)
UT = "bd1d9ddb04089700cf9c27f6f7426281"
POOL_UT = "7eea3edcaed734bea9cbfc24409ed989"

CACHE_SECONDS = 4.2
POOL_TTL_SECONDS = 25.0

# A 股连续竞价时段，按分钟取点。11:30 与 13:00 相邻但不留午休空档。
MORNING = [f"{h:02d}:{m:02d}" for h in (9, 10, 11) for m in range(60)
           if (h, m) >= (9, 30) and (h, m) <= (11, 30)]
AFTERNOON = [f"{h:02d}:{m:02d}" for h in (13, 14, 15) for m in range(60)
             if (h, m) >= (13, 1) and (h, m) <= (15, 0)]
SESSION_TIMES = MORNING + AFTERNOON

INDICES = [
    {"secid": "1.000001", "code": "000001", "name": "上证指数", "market": "sh"},
    {"secid": "0.399001", "code": "399001", "name": "深证成指", "market": "sz"},
]
QUOTE_SECIDS = "1.000001,0.399001,0.399006"

# 申万一级行业，共 31 个。使用东方财富板块代码批量取数，避免 496 个
# 细分行业造成的层级重复和热力图碎片化。
SECTOR_BOARDS = [
    {"code": "BK1201", "name": "电子"},
    {"code": "BK1283", "name": "银行"},
    {"code": "BK1216", "name": "医药生物"},
    {"code": "BK1203", "name": "非银金融"},
    {"code": "BK1200", "name": "电力设备"},
    {"code": "BK1215", "name": "通信"},
    {"code": "BK1205", "name": "机械设备"},
    {"code": "BK0464", "name": "石油石化"},
    {"code": "BK0478", "name": "有色金属"},
    {"code": "BK0427", "name": "公用事业"},
    {"code": "BK1206", "name": "基础化工"},
    {"code": "BK1211", "name": "汽车"},
    {"code": "BK0438", "name": "食品饮料"},
    {"code": "BK1207", "name": "计算机"},
    {"code": "BK1210", "name": "交通运输"},
    {"code": "BK1204", "name": "国防军工"},
    {"code": "BK0437", "name": "煤炭"},
    {"code": "BK0456", "name": "家用电器"},
    {"code": "BK1209", "name": "建筑装饰"},
    {"code": "BK0486", "name": "传媒"},
    {"code": "BK0433", "name": "农林牧渔"},
    {"code": "BK1208", "name": "建筑材料"},
    {"code": "BK1212", "name": "轻工制造"},
    {"code": "BK1202", "name": "房地产"},
    {"code": "BK1213", "name": "商贸零售"},
    {"code": "BK0479", "name": "钢铁"},
    {"code": "BK0728", "name": "环保"},
    {"code": "BK0436", "name": "纺织服饰"},
    {"code": "BK1214", "name": "社会服务"},
    {"code": "BK1035", "name": "美容护理"},
    {"code": "BK1217", "name": "综合"},
]
SECTOR_SECIDS = ",".join(f"90.{sector['code']}" for sector in SECTOR_BOARDS)


def now_cst() -> datetime:
    return datetime.now(CST)


def curl_json(url: str, timeout: float = 8.0) -> dict[str, Any]:
    """用系统 curl.exe 兜底：东方财富的 WAF 有时会直接掐断 Python 的 TLS 连接。"""
    curl = shutil.which("curl") or "curl"
    cmd = [
        curl,
        "-s",
        "--compressed",
        "--max-time",
        str(int(max(3, timeout))),
        "-A",
        UA,
        "-H",
        "Referer: https://quote.eastmoney.com/",
        "-H",
        "Accept: application/json,text/plain,*/*",
        url,
    ]
    result = subprocess.run(cmd, capture_output=True, timeout=timeout + 6)
    if result.returncode != 0 or not result.stdout:
        raise RuntimeError(f"curl 抓取失败: {result.stderr.decode('utf-8', 'ignore')[:120]}")
    payload = json.loads(result.stdout.decode("utf-8", "ignore"))
    if not isinstance(payload, dict):
        raise ValueError("行情源返回了非对象数据")
    return payload


def fetch_json(url: str, timeout: float = 8.0, attempts: int = 3) -> dict[str, Any]:
    """抓取 JSON。东方财富偶发空包或直接断连，因此带退避重试。"""
    headers = {
        "User-Agent": UA,
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Accept-Encoding": "gzip, deflate",
        "Referer": "https://quote.eastmoney.com/",
        "Connection": "close",
    }
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            req = Request(url, headers=headers)
            with urlopen(req, timeout=timeout) as response:
                raw = response.read()
                if response.headers.get("Content-Encoding", "").lower() == "gzip":
                    raw = gzip.decompress(raw)
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("行情源返回了非对象数据")
            return payload
        except (HTTPError, URLError, TimeoutError, ValueError, OSError) as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(0.4 + attempt * 0.7)
    # urllib 被拦截时改用系统 curl 再试一次。
    try:
        return curl_json(url, timeout)
    except Exception as exc:
        raise RuntimeError(f"请求行情源失败: {last_error}; curl: {exc}") from exc


def fetch_first(urls: list[str], timeout: float = 8.0, attempts: int = 2) -> dict[str, Any]:
    """依次尝试多个镜像地址，任一成功即返回。"""
    last_error: Exception | None = None
    for url in urls:
        try:
            return fetch_json(url, timeout, attempts)
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"所有行情地址均失败: {last_error}") from last_error


def fnum(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) else default
    except (TypeError, ValueError):
        return default


def quote_url() -> str:
    fields = "f1,f2,f3,f4,f6,f12,f13,f14,f104,f105,f106"
    return (
        "https://push2.eastmoney.com/api/qt/ulist/get"
        f"?fltt=2&invt=2&fields={fields}&secids={QUOTE_SECIDS}&ut={UT}"
    )


def snapshot_url() -> str:
    """指数与板块合并成一次请求，减少行情源压力。"""
    fields = "f1,f2,f3,f4,f6,f12,f13,f14,f20,f104,f105,f106,f128,f136"
    secids = f"{QUOTE_SECIDS},{SECTOR_SECIDS}"
    return (
        "https://push2.eastmoney.com/api/qt/ulist/get"
        f"?fltt=2&invt=2&fields={fields}&secids={secids}&ut={UT}"
    )


def sector_url() -> str:
    fields = "f12,f14,f2,f3,f4,f6,f20,f104,f105,f128,f136"
    return (
        "https://push2.eastmoney.com/api/qt/ulist/get"
        f"?fltt=2&invt=2&fields={fields}&secids={SECTOR_SECIDS}&ut={UT}"
    )


def parse_sectors(payload: dict[str, Any]) -> dict[str, Any]:
    data = payload.get("data")
    if not isinstance(data, dict) or not data.get("diff"):
        raise ValueError("板块行情为空")
    rows = {str(row.get("f12", "")): row for row in data["diff"]}
    items: list[dict[str, Any]] = []
    for board in SECTOR_BOARDS:
        row = rows.get(board["code"])
        if not row:
            continue
        raw_pct = row.get("f3")
        if raw_pct in (None, "-", ""):
            continue
        change_pct = fnum(raw_pct)
        market_cap = max(0.0, fnum(row.get("f20")))
        if market_cap <= 0:
            continue
        leader = row.get("f128")
        if leader in (None, "", "-"):
            leader = None
        items.append(
            {
                "code": board["code"],
                "name": board["name"],
                "group": board.get("group"),
                "changePct": round(change_pct, 2),
                "marketCap": market_cap,
                "turnover": max(0.0, fnum(row.get("f6"))),
                "up": int(fnum(row.get("f104"))),
                "down": int(fnum(row.get("f105"))),
                "leader": leader,
                "leaderChangePct": round(fnum(row.get("f136")), 2) if leader else None,
            }
        )
    if not items:
        raise ValueError("没有可用的板块数据")
    items.sort(key=lambda item: item["marketCap"], reverse=True)
    total_cap = sum(item["marketCap"] for item in items)
    weighted_pct = (
        sum(item["changePct"] * item["marketCap"] for item in items) / total_cap
        if total_cap
        else None
    )
    up_count = sum(1 for item in items if item["changePct"] > 0)
    down_count = sum(1 for item in items if item["changePct"] < 0)
    return summarize_sector_items(items)


def summarize_sector_items(items: list[dict[str, Any]]) -> dict[str, Any]:
    items.sort(key=lambda item: item["marketCap"], reverse=True)
    total_cap = sum(item["marketCap"] for item in items)
    weighted_pct = (
        sum(item["changePct"] * item["marketCap"] for item in items) / total_cap
        if total_cap
        else None
    )
    up_count = sum(1 for item in items if item["changePct"] > 0)
    down_count = sum(1 for item in items if item["changePct"] < 0)
    return {
        "basis": "marketCap",
        "count": len(items),
        "totalMarketCap": total_cap,
        "upCount": up_count,
        "downCount": down_count,
        "flatCount": len(items) - up_count - down_count,
        "weightedChangePct": round(weighted_pct, 2) if weighted_pct is not None else None,
        "items": items,
    }


def tencent_sectors() -> dict[str, Any]:
    """东财不可用时，用腾讯行业板块（同样是申万一级 31 个）兜底。"""
    url = (
        "https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank"
        "?board_type=hy&sort_type=price&direct=down&offset=0&count=40"
    )
    payload = fetch_json(url, 8.0, 1)
    rows = ((payload.get("data") or {}).get("rank_list")) or []
    items: list[dict[str, Any]] = []
    for row in rows:
        change_pct = fnum(row.get("zdf"), float("nan"))
        market_cap = fnum(row.get("zsz")) * 1e8
        if not math.isfinite(change_pct) or market_cap <= 0:
            continue
        up_part, _, down_part = str(row.get("zgb", "0/0")).partition("/")
        leader = row.get("lzg") or {}
        items.append(
            {
                "code": str(row.get("code") or row.get("name")),
                "name": str(row.get("name") or ""),
                "group": None,
                "changePct": round(change_pct, 2),
                "marketCap": market_cap,
                "turnover": max(0.0, fnum(row.get("turnover")) * 1e4),
                "up": int(fnum(up_part)),
                "down": int(fnum(down_part)),
                "leader": leader.get("name"),
                "leaderChangePct": round(fnum(leader.get("zdf")), 2) if leader else None,
            }
        )
    if not items:
        raise RuntimeError("备用板块源不可用")
    return summarize_sector_items(items)


def trends_urls(secid: str) -> list[str]:
    """分时地址：push2his 偶发拒绝，push2 也提供同一接口，互为备用。"""
    fields2 = "f51,f52,f53,f54,f55,f56,f57,f58"
    query = (
        f"?secid={secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11"
        f"&fields2={fields2}&iscr=0&ndays=2&ut={UT}"
    )
    return [
        f"https://push2his.eastmoney.com/api/qt/stock/trends2/get{query}",
        f"https://push2.eastmoney.com/api/qt/stock/trends2/get{query}",
    ]


def pool_url(kind: str, trade_date: str) -> str:
    sort = "fbt%3Aasc" if kind == "up" else "fund%3Aasc"
    endpoint = "getTopicZTPool" if kind == "up" else "getTopicDTPool"
    compact_date = trade_date.replace("-", "")
    return (
        f"https://push2ex.eastmoney.com/{endpoint}"
        f"?ut={POOL_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort={sort}"
        f"&date={compact_date}&_={int(time.time() * 1000)}"
    )


def parse_trends(payload: dict[str, Any]) -> dict[str, Any]:
    data = payload.get("data")
    if not isinstance(data, dict) or not data.get("trends"):
        raise ValueError("分时数据为空")
    days: dict[str, dict[str, dict[str, float]]] = {}
    for row in data["trends"]:
        parts = str(row).split(",")
        if len(parts) < 7:
            continue
        stamp = parts[0]
        if " " not in stamp:
            continue
        day, minute = stamp.split(" ", 1)
        # f53 为该分钟收盘，f57 为该分钟成交额（元）。
        days.setdefault(day, {})[minute] = {
            "close": fnum(parts[2]),
            "amount": max(0.0, fnum(parts[6])),
        }
    if not days:
        raise ValueError("分时数据无法解析")
    return {
        "preClose": fnum(data.get("preClose")),
        "days": days,
        "dates": sorted(days.keys()),
    }


def cumulative_curve(day: dict[str, dict[str, float]]) -> dict[str, float]:
    curve: dict[str, float] = {}
    total = 0.0
    for minute in SESSION_TIMES:
        point = day.get(minute)
        if point is None:
            continue
        total += point["amount"]
        curve[minute] = total
    return curve


def safe_div(numerator: float, denominator: float) -> float | None:
    if not denominator:
        return None
    return numerator / denominator


def parse_quotes(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    data = payload.get("data")
    if not isinstance(data, dict) or not data.get("diff"):
        raise ValueError("指数快照为空")
    result: dict[str, dict[str, Any]] = {}
    for row in data["diff"]:
        code = str(row.get("f12", ""))
        result[code] = row
    if "000001" not in result or "399001" not in result:
        raise ValueError("指数快照缺少沪深指数")
    return result


def parse_pool(payload: dict[str, Any]) -> dict[str, Any] | None:
    data = payload.get("data")
    if not isinstance(data, dict):
        return None
    total = data.get("tc")
    if total is None:
        pool = data.get("pool") or []
        total = len(pool)
    qdate = data.get("qdate")
    date_label = None
    if qdate:
        raw_date = str(qdate)
        date_label = (
            f"{raw_date[0:4]}-{raw_date[4:6]}-{raw_date[6:8]}"
            if len(raw_date) == 8 and raw_date.isdigit()
            else raw_date
        )
    return {"count": int(total), "date": date_label}


_pool_cache: dict[str, Any] = {"key": "", "at": 0.0, "data": None}
_pool_lock = threading.Lock()


def limit_pool(trade_date: str) -> dict[str, Any] | None:
    with _pool_lock:
        cached = _pool_cache.get("data")
        if (
            cached is not None
            and _pool_cache.get("key") == trade_date
            and time.time() - float(_pool_cache.get("at") or 0.0) < POOL_TTL_SECONDS
        ):
            return cached
    with ThreadPoolExecutor(max_workers=2) as pool:
        futs = {
            "up": pool.submit(fetch_json, pool_url("up", trade_date), 7.0, 1),
            "down": pool.submit(fetch_json, pool_url("down", trade_date), 7.0, 1),
        }
        results: dict[str, Any] = {}
        for key, future in futs.items():
            try:
                results[key] = parse_pool(future.result(timeout=12))
            except Exception:
                results[key] = None
    up = results.get("up")
    down = results.get("down")
    if not up and not down:
        raise RuntimeError("封板股池暂不可用")
    result = {
        "up": up["count"] if up else None,
        "down": down["count"] if down else None,
        "date": (up or down or {}).get("date") or trade_date,
    }
    with _pool_lock:
        _pool_cache["key"] = trade_date
        _pool_cache["at"] = time.time()
        _pool_cache["data"] = result
    return result


def weekday_cn(day: str) -> str:
    try:
        d = datetime.strptime(day, "%Y-%m-%d").date()
    except ValueError:
        return ""
    names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    return names[d.weekday()]


def market_session(latest_day: str, now: datetime) -> dict[str, Any]:
    today = now.date().isoformat()
    minute = now.hour * 60 + now.minute
    is_weekend = now.weekday() >= 5
    latest_is_today = latest_day == today
    label = "休市"
    state = "closed"
    note = ""

    if latest_is_today:
        if dtime(9, 30) <= now.time() <= dtime(11, 30):
            label, state = "交易中", "trading"
        elif dtime(11, 30) < now.time() < dtime(13, 0):
            label, state = "午间休市", "break"
        elif dtime(13, 0) <= now.time() <= dtime(15, 0):
            label, state = "交易中", "trading"
        elif now.time() > dtime(15, 0):
            label, state = "已收盘", "closed"
        else:
            label, state = "未开盘", "preopen"
    else:
        if is_weekend:
            label, state, note = "休市", "closed", "周末休市"
        elif minute < 9 * 60 + 30:
            label, state, note = "未开盘", "preopen", "等待开盘"
        elif minute > 15 * 60:
            label, state, note = "休市", "closed", "非交易日"
        else:
            label, state, note = "休市", "closed", "非交易日"

    if state != "trading":
        latest_label = datetime.strptime(latest_day, "%Y-%m-%d").strftime("%m月%d日")
        if state in ("closed", "preopen") and not note:
            note = f"最近交易日 {latest_label}"
        elif note:
            note = f"{note} · 最近交易日 {latest_label}"
    return {
        "state": state,
        "label": label,
        "isTrading": state == "trading",
        "note": note,
        "serverTime": now.isoformat(timespec="seconds"),
        "today": today,
        "weekday": weekday_cn(today),
    }


SECTOR_CACHE_SECONDS = 120.0
TRENDS_CACHE_SECONDS = 8.0
_sector_cache: dict[str, Any] = {"at": 0.0, "data": None}
_sector_lock = threading.Lock()
_trends_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_trends_lock = threading.Lock()


def parse_tencent_trends(payload: dict[str, Any], symbol: str) -> dict[str, Any]:
    """腾讯分时：每天一串「HHMM 价格 累计量 累计额」，需自行差分出每分钟成交额。"""
    node = (payload.get("data") or {}).get(symbol) or {}
    days_raw = node.get("data") or []
    days: dict[str, dict[str, dict[str, float]]] = {}
    for day in days_raw:
        raw_date = str(day.get("date") or "")
        if len(raw_date) != 8:
            continue
        date = f"{raw_date[0:4]}-{raw_date[4:6]}-{raw_date[6:8]}"
        minutes: dict[str, dict[str, float]] = {}
        prev_cum = 0.0
        for line in day.get("data") or []:
            parts = str(line).split(" ")
            if len(parts) < 4:
                continue
            hhmm = parts[0]
            if len(hhmm) != 4:
                continue
            minute = f"{hhmm[0:2]}:{hhmm[2:4]}"
            cum = fnum(parts[3])
            minutes[minute] = {
                "close": fnum(parts[1]),
                "amount": max(0.0, cum - prev_cum),
            }
            prev_cum = cum
        if minutes:
            days[date] = minutes
    if not days:
        raise ValueError("备用分时数据为空")
    return {"preClose": 0.0, "days": days, "dates": sorted(days.keys())}


def tencent_trends(symbol: str) -> dict[str, Any]:
    url = f"https://web.ifzq.gtimg.cn/appstock/app/day/query?code={symbol}"
    payload = fetch_json(url, 8.0, 1)
    return parse_tencent_trends(payload, symbol)


def load_trends(secid: str) -> dict[str, Any]:
    """分时数据按分钟更新，缓存 8 秒即可，显著减少上游请求。"""
    with _trends_lock:
        entry = _trends_cache.get(secid)
    if entry and time.time() - entry[0] < TRENDS_CACHE_SECONDS:
        return entry[1]
    data: dict[str, Any] | None = None
    if time.time() >= _push2_cooldown_until:
        try:
            payload = fetch_first(trends_urls(secid), 6.0, 1)
            data = parse_trends(payload)
        except Exception:
            data = None
    if data is None:
        symbol = "sh000001" if secid.startswith("1.") else "sz399001"
        try:
            data = tencent_trends(symbol)
        except Exception:
            if entry:
                return entry[1]
            raise
    with _trends_lock:
        _trends_cache[secid] = (time.time(), data)
    return data


def load_sectors() -> dict[str, Any]:
    """板块数据变化慢，缓存 120 秒；失败时先沿用缓存，再退到备用源。"""
    with _sector_lock:
        cached = _sector_cache.get("data")
        age = time.time() - float(_sector_cache.get("at") or 0.0)
        if cached is not None and age < SECTOR_CACHE_SECONDS:
            return cached
    data: dict[str, Any] | None = None
    try:
        payload = fetch_json(sector_url(), 6.0, 1)
        data = parse_sectors(payload)
    except Exception:
        if cached is not None:
            return cached
        data = tencent_sectors()
    with _sector_lock:
        _sector_cache["data"] = data
        _sector_cache["at"] = time.time()
    return data


def partial_payload(
    fetched_at: datetime,
    quotes: dict[str, dict[str, Any]],
    sectors: dict[str, Any] | None,
    sector_error: str | None,
    trends_error: str,
) -> dict[str, Any]:
    """分时接口不可用时，至少把快照类数据提供给页面。"""
    sh_quote = quotes["000001"]
    sz_quote = quotes["399001"]
    cyb_quote = quotes.get("399006", {})
    sh_amount = fnum(sh_quote.get("f6"))
    sz_amount = fnum(sz_quote.get("f6"))
    current_total = sh_amount + sz_amount
    breadth = breadth_from_quotes(quotes)
    sh_up = int(fnum(sh_quote.get("f104"))) if sh_quote.get("f104") is not None else None
    sh_down = int(fnum(sh_quote.get("f105"))) if sh_quote.get("f105") is not None else None
    sh_flat = int(fnum(sh_quote.get("f106"))) if sh_quote.get("f106") is not None else None
    sz_up = int(fnum(sz_quote.get("f104"))) if sz_quote.get("f104") is not None else None
    sz_down = int(fnum(sz_quote.get("f105"))) if sz_quote.get("f105") is not None else None
    sz_flat = int(fnum(sz_quote.get("f106"))) if sz_quote.get("f106") is not None else None
    today = fetched_at.date().isoformat()
    pre_close = fnum(sh_quote.get("f18"))
    if not pre_close:
        pre_close = fnum(sh_quote.get("f2")) - fnum(sh_quote.get("f4"))
    index_value = fnum(sh_quote.get("f2"))
    index_pct = fnum(sh_quote.get("f3"))

    warnings: list[str] = ["分时数据暂不可用，先显示行情快照"]
    if sector_error:
        warnings.append("板块热力图暂未更新")
    try:
        pools = limit_pool(today)
    except Exception:
        pools = None
        warnings.append("封板股池暂未更新")

    return {
        "ok": True,
        "partial": True,
        "fetchedAt": fetched_at.isoformat(timespec="seconds"),
        "asOf": f"{today} {fetched_at.strftime('%H:%M')}",
        "tradeDate": today,
        "tradeDateLabel": today.replace("-", "."),
        "tradeWeekday": weekday_cn(today),
        "prevTradeDate": None,
        "prevTradeDateLabel": "—",
        "latestDateLabel": f"{today[5:7]}月{today[8:10]}日",
        "session": market_session(today, fetched_at),
        "index": {
            "code": "000001",
            "name": "上证指数",
            "value": round(index_value, 2),
            "change": round(fnum(sh_quote.get("f4")), 2),
            "changePct": round(index_pct, 2),
            "preClose": round(pre_close, 2),
            "amount": sh_amount,
            "amountPrevFull": None,
        },
        "markets": {
            "sh": {
                "name": "上证指数",
                "value": round(fnum(sh_quote.get("f2")), 2),
                "change": round(fnum(sh_quote.get("f4")), 2),
                "changePct": round(fnum(sh_quote.get("f3")), 2),
                "amount": sh_amount,
                "up": sh_up,
                "down": sh_down,
                "flat": sh_flat,
            },
            "sz": {
                "name": "深证成指",
                "value": round(fnum(sz_quote.get("f2")), 2),
                "change": round(fnum(sz_quote.get("f4")), 2),
                "changePct": round(fnum(sz_quote.get("f3")), 2),
                "amount": sz_amount,
                "up": sz_up,
                "down": sz_down,
                "flat": sz_flat,
            },
            "cyb": {
                "name": "创业板指",
                "value": round(fnum(cyb_quote.get("f2")), 2),
                "changePct": round(fnum(cyb_quote.get("f3")), 2),
            },
        },
        "breadth": breadth,
        "limits": pools,
        "sectors": sectors,
        "turnover": {
            "current": current_total,
            "currentSh": sh_amount,
            "currentSz": sz_amount,
            "prevSameTime": None,
            "prevSameTimeSh": None,
            "prevSameTimeSz": None,
            "delta": None,
            "deltaPct": None,
            "prevFull": None,
            "prevFullSh": None,
            "prevFullSz": None,
            "previousComplete": False,
            "asOf": fetched_at.strftime("%H:%M"),
        },
        "series": {
            "times": SESSION_TIMES,
            "latestIndex": -1,
            "index": [],
            "indexPct": [],
            "prevIndex": [],
            "currentTurnover": [],
            "previousTurnover": [],
            "turnoverDelta": [],
        },
        "warnings": warnings,
        "errorDetail": trends_error,
    }


def fallback_quotes() -> dict[str, dict[str, Any]]:
    """东方财富不可用时，用腾讯行情兜底指数现价与成交额。"""
    url = "https://qt.gtimg.cn/q=sh000001,sz399001,sz399006"
    req = Request(url, headers={"User-Agent": UA, "Referer": "https://finance.qq.com/"})
    with urlopen(req, timeout=8) as response:
        text = response.read().decode("gbk", "ignore")
    result: dict[str, dict[str, Any]] = {}
    for line in text.splitlines():
        if '="' not in line:
            continue
        body = line.split('="', 1)[1].rstrip('";')
        parts = body.split("~")
        if len(parts) < 38:
            continue
        code = parts[2]
        amount = fnum(parts[35].split("/")[2]) if "/" in parts[35] else fnum(parts[37]) * 10000
        result[code] = {
            "f12": code,
            "f14": parts[1],
            "f2": fnum(parts[3]),
            "f3": fnum(parts[32]),
            "f4": fnum(parts[31]),
            "f6": amount,
            "f18": fnum(parts[4]),
            "f104": None,
            "f105": None,
            "f106": None,
        }
    if "000001" not in result or "399001" not in result:
        raise RuntimeError("备用行情源不可用")
    return result


def breadth_from_quotes(quotes: dict[str, dict[str, Any]]) -> dict[str, Any]:
    sh = quotes.get("000001", {})
    sz = quotes.get("399001", {})
    if sh.get("f104") is None or sz.get("f104") is None:
        return {
            "up": None, "down": None, "flat": None, "total": None,
            "upPct": None, "downPct": None, "flatPct": None, "ratio": None,
        }
    up = int(fnum(sh.get("f104"))) + int(fnum(sz.get("f104")))
    down = int(fnum(sh.get("f105"))) + int(fnum(sz.get("f105")))
    flat = int(fnum(sh.get("f106"))) + int(fnum(sz.get("f106")))
    total = up + down + flat
    return {
        "up": up,
        "down": down,
        "flat": flat,
        "total": total,
        "upPct": round(up / total * 100, 1) if total else None,
        "downPct": round(down / total * 100, 1) if total else None,
        "flatPct": round(flat / total * 100, 1) if total else None,
        "ratio": round(up / down, 2) if down else None,
    }


_push2_cooldown_until = 0.0


def build_dashboard() -> dict[str, Any]:
    global _push2_cooldown_until
    fetched_at = now_cst()
    # 指数与板块共用一次 ulist 请求；失败再退回分开请求。
    sector_error: str | None = None
    sectors: dict[str, Any] | None = None
    snapshot = None
    quotes: dict[str, dict[str, Any]] | None = None

    if time.time() >= _push2_cooldown_until:
        try:
            snapshot = fetch_json(snapshot_url(), 6.0, 1)
            quotes = parse_quotes(snapshot)
        except Exception:
            try:
                quotes = parse_quotes(fetch_json(quote_url(), 6.0, 1))
            except Exception:
                _push2_cooldown_until = time.time() + 20.0
    if quotes is None:
        # 东方财富被限流时，先用备用源，60 秒后再试东财，避免每次都等重试。
        quotes = fallback_quotes()

    if snapshot is not None:
        try:
            sectors = parse_sectors(snapshot)
            with _sector_lock:
                _sector_cache["data"] = sectors
                _sector_cache["at"] = time.time()
        except Exception as exc:
            with _sector_lock:
                sectors = _sector_cache.get("data")
            if not sectors:
                sector_error = str(exc)
    if sectors is None:
        try:
            sectors = load_sectors()
        except Exception as exc:
            sector_error = sector_error or str(exc)

    trends_error = ""
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            sh_future = pool.submit(load_trends, INDICES[0]["secid"])
            sz_future = pool.submit(load_trends, INDICES[1]["secid"])
            sh = sh_future.result()
            sz = sz_future.result()
    except Exception as exc:
        trends_error = str(exc)
        sh = sz = None

    if not sh or not sz:
        return partial_payload(fetched_at, quotes, sectors, sector_error, trends_error)

    all_dates = sorted(set(sh["dates"]) | set(sz["dates"]))
    if not all_dates:
        raise RuntimeError("分时数据缺少交易日")
    latest_day = all_dates[-1]
    previous_day = all_dates[-2] if len(all_dates) >= 2 else None

    sh_day = sh["days"].get(latest_day, {})
    sz_day = sz["days"].get(latest_day, {})
    if not sh_day or not sz_day:
        raise RuntimeError("沪深分时数据不完整")

    latest_minute = max(
        (m for m in sh_day if m in sz_day),
        key=lambda m: SESSION_TIMES.index(m) if m in SESSION_TIMES else -1,
        default=None,
    )
    if latest_minute is None:
        raise RuntimeError("沪深分时没有对齐的时点")

    # 上一交易日同时段与全天
    prev_sh_curve: dict[str, float] = {}
    prev_sz_curve: dict[str, float] = {}
    prev_total_curve: dict[str, float] = {}
    prev_full_total = None
    if previous_day:
        prev_sh = sh["days"].get(previous_day, {})
        prev_sz = sz["days"].get(previous_day, {})
        prev_sh_curve = cumulative_curve(prev_sh)
        prev_sz_curve = cumulative_curve(prev_sz)
        if prev_sh_curve and prev_sz_curve:
            for minute in SESSION_TIMES:
                if minute in prev_sh_curve and minute in prev_sz_curve:
                    prev_total_curve[minute] = prev_sh_curve[minute] + prev_sz_curve[minute]
        if prev_total_curve:
            last_prev_minute = max(
                prev_total_curve,
                key=lambda m: SESSION_TIMES.index(m) if m in SESSION_TIMES else -1,
            )
            prev_full_total = prev_total_curve[last_prev_minute]

    cur_sh_curve = cumulative_curve(sh_day)
    cur_sz_curve = cumulative_curve(sz_day)
    cur_total_curve: dict[str, float] = {}
    for minute in SESSION_TIMES:
        if minute in cur_sh_curve and minute in cur_sz_curve and minute <= latest_minute:
            cur_total_curve[minute] = cur_sh_curve[minute] + cur_sz_curve[minute]

    latest_prev = prev_total_curve.get(latest_minute)
    latest_prev_sh = prev_sh_curve.get(latest_minute)
    latest_prev_sz = prev_sz_curve.get(latest_minute)

    sh_quote = quotes["000001"]
    sz_quote = quotes["399001"]
    cyb_quote = quotes.get("399006", {})

    sh_amount = fnum(sh_quote.get("f6"))
    sz_amount = fnum(sz_quote.get("f6"))
    if sh_amount <= 0:
        sh_amount = cur_sh_curve.get(latest_minute, 0.0)
    if sz_amount <= 0:
        sz_amount = cur_sz_curve.get(latest_minute, 0.0)
    current_total = sh_amount + sz_amount

    # 让曲线末端与指数快照中的实时成交额对齐（两者来自同一行情源，误差极小）。
    if current_total > 0 and latest_minute in cur_total_curve:
        cur_total_curve[latest_minute] = current_total
        if sh_amount > 0:
            cur_sh_curve[latest_minute] = sh_amount
        if sz_amount > 0:
            cur_sz_curve[latest_minute] = sz_amount

    turnover_delta = None
    turnover_delta_pct = None
    if latest_prev and latest_prev > 0:
        turnover_delta = current_total - latest_prev
        turnover_delta_pct = turnover_delta / latest_prev * 100

    index_curve: list[float | None] = []
    index_pct_curve: list[float | None] = []
    prev_index_curve: list[float | None] = []
    current_curve: list[float | None] = []
    previous_curve: list[float | None] = []
    delta_curve: list[float | None] = []
    pre_close = sh["preClose"] or fnum(sh_quote.get("f18"))
    if not pre_close:
        # 快照里没有昨收时，用现价减涨跌额反推。
        pre_close = fnum(sh_quote.get("f2")) - fnum(sh_quote.get("f4"))

    previous_complete = bool(previous_day and prev_total_curve and max(prev_total_curve) == "15:00")
    for minute in SESSION_TIMES:
        sh_point = sh_day.get(minute)
        show = sh_point is not None and minute <= latest_minute
        close = sh_point["close"] if show and sh_point else None
        index_curve.append(close)
        index_pct_curve.append(
            (close / pre_close - 1) * 100 if close is not None and pre_close else None
        )

        prev_sh_point = sh["days"].get(previous_day, {}).get(minute) if previous_day else None
        prev_index_curve.append(prev_sh_point["close"] if prev_sh_point else None)

        current_curve.append(cur_total_curve.get(minute) if show else None)
        prev_value = prev_total_curve.get(minute)
        previous_curve.append(prev_value)

        if show and prev_value is not None:
            delta_curve.append(cur_total_curve.get(minute, current_total) - prev_value)
        else:
            delta_curve.append(None)

    index_value = fnum(sh_quote.get("f2")) or float(sh["days"][latest_day][latest_minute]["close"])
    index_change = fnum(sh_quote.get("f4"))
    index_pct = fnum(sh_quote.get("f3"))
    if not index_pct and pre_close:
        index_pct = (index_value / pre_close - 1) * 100

    breadth = breadth_from_quotes(quotes)
    sh_up = int(fnum(sh_quote.get("f104"))) if sh_quote.get("f104") is not None else None
    sh_down = int(fnum(sh_quote.get("f105"))) if sh_quote.get("f105") is not None else None
    sh_flat = int(fnum(sh_quote.get("f106"))) if sh_quote.get("f106") is not None else None
    sz_up = int(fnum(sz_quote.get("f104"))) if sz_quote.get("f104") is not None else None
    sz_down = int(fnum(sz_quote.get("f105"))) if sz_quote.get("f105") is not None else None
    sz_flat = int(fnum(sz_quote.get("f106"))) if sz_quote.get("f106") is not None else None

    session = market_session(latest_day, fetched_at)

    warnings: list[str] = []
    if breadth.get("up") is None and sectors and sectors.get("items"):
        up_sum = sum(int(item.get("up") or 0) for item in sectors["items"])
        down_sum = sum(int(item.get("down") or 0) for item in sectors["items"])
        if up_sum + down_sum > 0:
            breadth = {
                "up": up_sum,
                "down": down_sum,
                "flat": 0,
                "total": up_sum + down_sum,
                "upPct": round(up_sum / (up_sum + down_sum) * 100, 1),
                "downPct": round(down_sum / (up_sum + down_sum) * 100, 1),
                "flatPct": 0.0,
                "ratio": round(up_sum / down_sum, 2) if down_sum else None,
                "estimated": True,
            }
            warnings.append("涨跌家数按行业板块汇总估算")
    if sector_error:
        warnings.append("板块热力图暂未更新")
    try:
        pools = limit_pool(latest_day)
    except Exception:
        pools = None
        warnings.append("封板股池暂未更新")
    if pools and (pools.get("up") is None or pools.get("down") is None):
        warnings.append("部分封板股池数据缺失")

    previous_date_label = (
        f"{previous_day[5:7]}月{previous_day[8:10]}日" if previous_day else "—"
    )
    latest_date_label = f"{latest_day[5:7]}月{latest_day[8:10]}日"

    return {
        "ok": True,
        "fetchedAt": fetched_at.isoformat(timespec="seconds"),
        "asOf": f"{latest_day} {latest_minute}",
        "tradeDate": latest_day,
        "tradeDateLabel": latest_day.replace("-", "."),
        "tradeWeekday": weekday_cn(latest_day),
        "prevTradeDate": previous_day,
        "prevTradeDateLabel": previous_date_label,
        "latestDateLabel": latest_date_label,
        "session": session,
        "index": {
            "code": "000001",
            "name": "上证指数",
            "value": round(index_value, 2),
            "change": round(index_change, 2),
            "changePct": round(index_pct, 2),
            "preClose": round(pre_close, 2),
            "amount": sh_amount,
            "amountPrevFull": (
                prev_sh_curve.get(max(prev_sh_curve), 0.0) if prev_sh_curve else None
            ),
        },
        "markets": {
            "sh": {
                "name": "上证指数",
                "value": round(fnum(sh_quote.get("f2")), 2),
                "change": round(fnum(sh_quote.get("f4")), 2),
                "changePct": round(fnum(sh_quote.get("f3")), 2),
                "amount": sh_amount,
                "up": sh_up,
                "down": sh_down,
                "flat": sh_flat,
            },
            "sz": {
                "name": "深证成指",
                "value": round(fnum(sz_quote.get("f2")), 2),
                "change": round(fnum(sz_quote.get("f4")), 2),
                "changePct": round(fnum(sz_quote.get("f3")), 2),
                "amount": sz_amount,
                "up": sz_up,
                "down": sz_down,
                "flat": sz_flat,
            },
            "cyb": {
                "name": "创业板指",
                "value": round(fnum(cyb_quote.get("f2")), 2),
                "changePct": round(fnum(cyb_quote.get("f3")), 2),
            },
        },
        "breadth": breadth,
        "limits": pools,
        "sectors": sectors,
        "turnover": {
            "current": current_total,
            "currentSh": sh_amount,
            "currentSz": sz_amount,
            "prevSameTime": latest_prev,
            "prevSameTimeSh": latest_prev_sh,
            "prevSameTimeSz": latest_prev_sz,
            "delta": turnover_delta,
            "deltaPct": turnover_delta_pct,
            "prevFull": prev_full_total,
            "prevFullSh": (
                prev_sh_curve.get(max(prev_sh_curve), 0.0) if prev_sh_curve else None
            ),
            "prevFullSz": (
                prev_sz_curve.get(max(prev_sz_curve), 0.0) if prev_sz_curve else None
            ),
            "previousComplete": previous_complete,
            "asOf": latest_minute,
        },
        "series": {
            "times": SESSION_TIMES,
            "latestIndex": SESSION_TIMES.index(latest_minute),
            "index": index_curve,
            "indexPct": index_pct_curve,
            "prevIndex": prev_index_curve,
            "currentTurnover": current_curve,
            "previousTurnover": previous_curve,
            "turnoverDelta": delta_curve,
        },
        "warnings": warnings,
    }


class AppState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.fetch_lock = threading.Lock()
        self.payload: dict[str, Any] | None = None
        self.cached_at = 0.0
        self.last_attempt = 0.0
        self.last_error: str | None = None
        self.failures = 0

    def _backoff_remaining(self, now: float) -> float:
        """连续失败时退让，避免把行情源的限流越拖越久。"""
        if self.failures <= 0:
            return 0.0
        wait = min(30.0, 5.0 * self.failures)
        return max(0.0, wait - (now - self.last_attempt))

    def _stale_payload(self, message: str | None) -> dict[str, Any] | None:
        if not self.payload:
            return None
        old = dict(self.payload)
        old["cached"] = True
        old["stale"] = True
        old["checkedAt"] = now_cst().isoformat(timespec="seconds")
        old["warning"] = "行情源异常，已保留上次成功数据"
        if message:
            old["errorDetail"] = message
        return old

    def snapshot(self, force: bool = False) -> tuple[dict[str, Any], int]:
        now = time.time()
        with self.lock:
            fresh_enough = (
                self.payload is not None and now - self.cached_at < CACHE_SECONDS and not force
            )
            if fresh_enough:
                payload = dict(self.payload or {})
                payload["cached"] = True
                payload["checkedAt"] = now_cst().isoformat(timespec="seconds")
                return payload, 200
            if not force and self._backoff_remaining(now) > 0:
                stale = self._stale_payload(self.last_error)
                if stale is not None:
                    return stale, 200

        with self.fetch_lock:
            now = time.time()
            with self.lock:
                fresh_enough = (
                    self.payload is not None
                    and now - self.cached_at < CACHE_SECONDS
                    and not force
                )
                if fresh_enough:
                    payload = dict(self.payload or {})
                    payload["cached"] = True
                    payload["checkedAt"] = now_cst().isoformat(timespec="seconds")
                    return payload, 200
                if not force and self._backoff_remaining(now) > 0:
                    stale = self._stale_payload(self.last_error)
                    if stale is not None:
                        return stale, 200

            try:
                payload = build_dashboard()
                with self.lock:
                    self.payload = payload
                    self.cached_at = time.time()
                    self.last_attempt = self.cached_at
                    self.last_error = None
                    self.failures = 0
                result = dict(payload)
                result["cached"] = False
                result["stale"] = False
                result["checkedAt"] = now_cst().isoformat(timespec="seconds")
                return result, 200
            except Exception as exc:
                message = str(exc)
                with self.lock:
                    self.last_attempt = time.time()
                    self.last_error = message
                    self.failures += 1
                    old = dict(self.payload) if self.payload else None
                if old is not None:
                    old["cached"] = True
                    old["stale"] = True
                    old["checkedAt"] = now_cst().isoformat(timespec="seconds")
                    old["warning"] = "行情源异常，已保留上次成功数据"
                    old["errorDetail"] = message
                    return old, 200
                return {
                    "ok": False,
                    "error": "暂时无法连接行情源",
                    "detail": message,
                    "checkedAt": now_cst().isoformat(timespec="seconds"),
                }, 502


STATE = AppState()


class Handler(BaseHTTPRequestHandler):
    server_version = "PulseBoard/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        # pythonw.exe（无控制台）下 sys.stderr 为 None，写日志会抛异常并
        # 导致连接被直接关闭，所以先判断再输出。
        if sys.stderr is None:
            return
        if args and str(args[0]).startswith("GET /api/"):
            return
        try:
            super().log_message(fmt, *args)
        except (OSError, ValueError, AttributeError):
            pass

    def log_error(self, fmt: str, *args: Any) -> None:
        self.log_message(fmt, *args)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/dashboard":
            self.handle_api()
            return
        if parsed.path == "/api/health":
            self.respond_json(
                {"ok": True, "time": now_cst().isoformat(timespec="seconds"),
                 "hasCache": STATE.payload is not None}
            )
            return
        self.serve_static(parsed.path)

    def handle_api(self) -> None:
        try:
            payload, status = STATE.snapshot(force=False)
            self.respond_json(payload, status)
        except Exception as exc:  # 最后一道兜底，保证浏览器总能拿到 JSON
            self.respond_json(
                {"ok": False, "error": "服务内部错误", "detail": str(exc)}, 500
            )

    def serve_static(self, path: str) -> None:
        if path in ("", "/"):
            target = BASE_DIR / "index.html"
        else:
            relative = path.lstrip("/")
            allowed = {"index.html", "styles.css", "app.js", "favicon.svg"}
            if relative not in allowed:
                self.send_error(404, "Not Found")
                return
            target = BASE_DIR / relative
        if not target.is_file():
            self.send_error(404, "Not Found")
            return
        content = target.read_bytes()
        content_type, _ = mimetypes.guess_type(str(target))
        if target.suffix == ".js":
            content_type = "text/javascript; charset=utf-8"
        elif target.suffix == ".css":
            content_type = "text/css; charset=utf-8"
        elif target.suffix == ".html":
            content_type = "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def respond_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


def find_port(host: str, start: int, attempts: int = 20) -> int:
    for port in range(start, start + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"端口 {start}-{start + attempts - 1} 均被占用")


def lan_addresses() -> list[str]:
    """返回本机可供局域网访问的 IPv4 地址。"""
    addresses: set[str] = set()
    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = item[4][0]
            if not ip.startswith("127.") and not ip.startswith("169.254."):
                addresses.add(ip)
    except OSError:
        pass
    return sorted(addresses, key=lambda ip: (not ip.startswith("192.168."), ip))


def ensure_standard_streams() -> None:
    """pythonw.exe 下 stdout/stderr 为 None，print 和日志都会抛异常。

    用 devnull 兜底，保证静默启动时服务稳定运行。
    """
    for name in ("stdout", "stderr"):
        if getattr(sys, name, None) is None:
            try:
                setattr(sys, name, open(os.devnull, "w", encoding="utf-8"))
            except OSError:
                pass


def main() -> None:
    ensure_standard_streams()
    parser = argparse.ArgumentParser(description="A 股实时量能看板")
    parser.add_argument("--port", type=int, default=8765, help="本地端口，默认 8765")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认仅本机")
    parser.add_argument("--lan", action="store_true", help="允许同一局域网内的手机访问")
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = parser.parse_args()

    host = "0.0.0.0" if args.lan else args.host
    port = find_port(host, args.port)
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    local_url = f"http://127.0.0.1:{port}"
    browser_url = local_url if host in ("0.0.0.0", "127.0.0.1") else f"http://{host}:{port}"

    print("")
    print("  量能脉搏 · A股实时看板")
    print(f"  电脑访问: {local_url}")
    if args.lan:
        addresses = lan_addresses()
        if addresses:
            for address in addresses:
                print(f"  手机访问: http://{address}:{port}")
        else:
            print(f"  手机访问: http://<本机局域网IP>:{port}")
        print("  手机需与电脑在同一 Wi-Fi / 局域网。")
        print("  若无法打开，请在 Windows 防火墙中允许 Python 的入站访问。")
    print("  按 Ctrl+C 停止服务")
    print("")
    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(browser_url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
