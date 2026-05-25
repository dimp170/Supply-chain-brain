"""RSS scraping engine with fuzzy port matching to score maritime threats."""
from __future__ import annotations

import asyncio
import html
import json
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Iterable

import httpx

from .database import upsert_port_alert

RSS_FEEDS = [
    "https://gcaptain.com/feed/",
    "https://splash247.com/feed/",
]

CRITICAL_KEYWORDS = {
    "blockade", "strike", "missile", "explosion",
    "closure", "attack", "war", "seized", "fire",
}
WARNING_KEYWORDS = {
    "delay", "congestion", "accident", "protest",
    "weather", "spill", "collision", "grounding", "outage",
}

_ITEM_RE = re.compile(r"<item[^>]*>(.*?)</item>", re.IGNORECASE | re.DOTALL)
_TITLE_RE = re.compile(r"<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>", re.IGNORECASE | re.DOTALL)
_DESC_RE = re.compile(r"<description[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</description>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")


@dataclass
class Article:
    title: str
    description: str

    @property
    def text(self) -> str:
        return f"{self.title} {self.description}".lower()


class PortRiskEngine:
    def __init__(self, ports_path: Path | None = None) -> None:
        if ports_path is None:
            # backend/services/risk_engine.py → parent.parent.parent is repo root.
            ports_path = Path(__file__).resolve().parent.parent.parent / "data" / "ports.json"
        self.ports: dict[str, dict] = {}
        try:
            with open(ports_path, "r", encoding="utf-8") as fh:
                self.ports = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[risk_engine] failed to load ports.json: {exc}")

        self._port_index: list[tuple[str, str]] = [
            (code, info["name"].lower()) for code, info in self.ports.items()
        ]

    # ---------- feed retrieval ----------

    async def _fetch_feed(self, client: httpx.AsyncClient, url: str) -> list[Article]:
        try:
            resp = await client.get(url, timeout=15.0, follow_redirects=True)
            resp.raise_for_status()
            return list(self._parse(resp.text))
        except (httpx.HTTPError, ValueError) as exc:
            print(f"[risk_engine] feed fetch failed {url}: {exc}")
            return []

    def _parse(self, xml: str) -> Iterable[Article]:
        for item in _ITEM_RE.findall(xml):
            title_m = _TITLE_RE.search(item)
            desc_m = _DESC_RE.search(item)
            title = self._clean(title_m.group(1) if title_m else "")
            desc = self._clean(desc_m.group(1) if desc_m else "")
            if title or desc:
                yield Article(title=title, description=desc)

    @staticmethod
    def _clean(s: str) -> str:
        s = _TAG_RE.sub(" ", s)
        s = html.unescape(s)
        return re.sub(r"\s+", " ", s).strip()

    # ---------- scoring ----------

    def _match_port(self, text: str) -> tuple[str, str] | None:
        upper = text.upper()
        for code in self.ports:
            if code in upper:
                return code, self.ports[code]["name"]

        best: tuple[str, str] | None = None
        best_score = 0.0
        for code, name in self._port_index:
            if name in text:
                return code, self.ports[code]["name"]
            score = SequenceMatcher(None, name, text[: len(name) + 40]).ratio()
            if score > best_score and score >= 0.78:
                best_score = score
                best = (code, self.ports[code]["name"])
        return best

    @staticmethod
    def _score(text: str) -> str | None:
        words = set(re.findall(r"[a-z]+", text))
        if words & CRITICAL_KEYWORDS:
            return "CRITICAL"
        if words & WARNING_KEYWORDS:
            return "WARNING"
        return None

    # ---------- worker entry points ----------

    async def refresh_once(self) -> int:
        commits = 0
        try:
            async with httpx.AsyncClient(headers={"User-Agent": "supply-chain-brain/1.0"}) as client:
                feeds = await asyncio.gather(*[self._fetch_feed(client, u) for u in RSS_FEEDS])
        except Exception as exc:
            print(f"[risk_engine] refresh failed: {exc}")
            return 0

        for articles in feeds:
            for art in articles:
                level = self._score(art.text)
                if level is None:
                    continue
                match = self._match_port(art.text)
                if match is None:
                    continue
                code, port_name = match
                incident = art.title[:300] if art.title else art.description[:300]
                try:
                    upsert_port_alert(code, port_name, level, incident)
                    commits += 1
                except Exception as exc:
                    print(f"[risk_engine] persist failed: {exc}")
        return commits

    async def run_forever(self, interval_seconds: int = 600) -> None:
        while True:
            try:
                count = await self.refresh_once()
                print(f"[risk_engine] refreshed alerts ({count} updated)")
            except Exception as exc:
                print(f"[risk_engine] cycle error: {exc}")
            await asyncio.sleep(interval_seconds)
