"""Playwright 自动化：在抖音网页版私信页面给指定好友发送消息。

发送逻辑参考 douyin-cloud-streak（MIT），要点：
- 点击联系人后校验右侧会话确实切换（防止限流时错发给上一个人）；
- 列表点击失败时用搜索框兜底；
- 检测"操作频繁 / 安全验证"等提示，命中即停本轮；
- 发送前清空输入框，发送后校验输入框已清空。
"""

from __future__ import annotations

import logging
import random
import time
from datetime import datetime

from playwright.sync_api import sync_playwright

from .config import DATA_DIR, load_config

logger = logging.getLogger("douyin-spark")

STATE_PATH = DATA_DIR / "state.json"
SCREENSHOT_PATH = DATA_DIR / "last_error.png"
CHAT_URL = "https://www.douyin.com/chat"

RATE_LIMIT_KEYWORDS = [
    "操作频繁",
    "操作太频繁",
    "发送过于频繁",
    "请稍后再试",
    "稍后再试",
    "安全验证",
    "滑动验证",
    "验证码",
    "验证中心",
    "人机验证",
    "网络异常",
    "请勿频繁",
]

LOGIN_TEXTS = ["扫码登录", "验证码登录", "登录后查看", "登录后即可"]


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _screenshot(page) -> None:
    try:
        page.screenshot(path=str(SCREENSHOT_PATH), timeout=5000)
        logger.info("已保存页面截图: %s", SCREENSHOT_PATH)
    except Exception:
        pass


def check_login(page) -> tuple[bool, str]:
    """返回 (是否已登录, 说明)。宁可误报掉线，也不要带着过期登录态硬跑。"""
    url = page.url
    if "login" in url.lower() or "passport" in url.lower():
        return False, f"页面已跳转到登录页（{url}）"

    try:
        qr = page.locator("#animate_qrcode_container")
        if qr.count() and qr.first.is_visible():
            return False, "页面出现扫码登录二维码，登录态已过期"
    except Exception:
        pass

    for text in LOGIN_TEXTS:
        try:
            loc = page.get_by_text(text, exact=False)
            for i in range(min(loc.count(), 3)):
                if loc.nth(i).is_visible():
                    return False, f"页面出现登录提示「{text}」"
        except Exception:
            continue

    cookies = page.context.cookies()
    if not any(c["name"].startswith("sessionid") for c in cookies):
        return False, "未检测到 sessionid Cookie"
    return True, "ok"


def detect_rate_limit(page) -> str | None:
    for kw in RATE_LIMIT_KEYWORDS:
        try:
            loc = page.get_by_text(kw, exact=False)
            for i in range(loc.count()):
                if loc.nth(i).bounding_box():
                    return kw
        except Exception:
            continue
    return None


def _find_contact(page, name: str):
    """优先按全文精确匹配联系人标题，避免误点其他会话里的消息预览。"""
    exact = page.get_by_text(name, exact=True)
    if exact.count():
        return exact.first
    return page.locator(".conversationConversationItemtitle").filter(has_text=name).first


def _visible_contact_title(page, name: str):
    """只返回左侧聊天列表里可见的精确标题，避开虚拟列表保留的隐藏旧节点。"""
    titles = page.locator(".conversationConversationItemtitle")
    count = titles.count()
    for i in range(count):
        item = titles.nth(i)
        try:
            text = (item.inner_text(timeout=1000) or "").strip()
            box = item.bounding_box(timeout=1000)
        except Exception:
            continue
        if text == name and box and box.get("x", 9999) < 360:
            return item
    return None


def verify_in_conversation(page, name: str) -> bool:
    """右侧会话顶部标题区域（x>300 且 y<100）出现目标昵称才算切换成功，防止错发。"""
    for exact in (True, False):
        try:
            loc = page.get_by_text(name, exact=exact)
            for i in range(loc.count()):
                try:
                    box = loc.nth(i).bounding_box()
                except Exception:
                    continue
                if box and box.get("x", 0) > 300 and box.get("y", 0) < 100:
                    return True
        except Exception:
            continue
    return False


def search_and_open(page, name: str) -> bool:
    try:
        box = page.get_by_placeholder("搜索", exact=False).first
        if box.count() == 0:
            return False
        box.click()
        box.fill(name)
        time.sleep(4)
        # 优先直接点搜索结果里的「发消息」按钮，最可靠
        btn = page.get_by_text("发消息", exact=False).first
        if btn.count():
            btn.click(force=True)
            time.sleep(4)
            return True
        # 否则点精确匹配的结果卡片，再找「发消息」入口
        candidate = page.get_by_text(name, exact=True).first
        if candidate.count() == 0:
            candidate = page.get_by_text(name, exact=False).first
        if candidate.count() == 0:
            return False
        candidate.click(force=True)
        time.sleep(3)
        btn = page.get_by_text("发消息", exact=False).first
        if btn.count():
            btn.click(force=True)
            time.sleep(3)
        return True
    except Exception as e:
        logger.info("搜索打开 %s 失败: %s", name, e)
        return False


def _type_and_send(page, input_box, msg_text: str) -> bool:
    """把文字输入输入框并按 Enter 发送，返回文字是否成功进入输入框。"""
    try:
        input_box.click()
        time.sleep(0.4)
        page.keyboard.press("Control+A")
        page.keyboard.press("Delete")
        time.sleep(0.3)
        page.keyboard.type(msg_text, delay=100)
        time.sleep(0.8)
        cur = input_box.inner_text() or ""
        if msg_text not in cur:
            logger.warning("文字未进入输入框，当前内容: %r", cur[:30])
            return False
        page.keyboard.press("Enter")
        return True
    except Exception as e:
        logger.info("输入/发送异常: %s", str(e)[:100])
        return False


def _wait_input_cleared(input_box, msg_text: str, wait: float = 8) -> bool:
    """消息发出后输入框应不再包含发送文字，以此确认真正发出。"""
    deadline = time.time() + wait
    while time.time() < deadline:
        time.sleep(1)
        try:
            cur = input_box.inner_text() or ""
            if msg_text not in cur:
                return True
        except Exception:
            pass
    return False


def send_to_contact(page, name: str, msg_text: str, dry_run: bool) -> tuple[bool, str]:
    switched = False
    for attempt in range(12):
        try:
            target = _visible_contact_title(page, name)
            if target:
                target.click(force=True, timeout=10000)
                time.sleep(random.uniform(2, 4))
                if verify_in_conversation(page, name):
                    switched = True
                    break
            else:
                # 目标可能因列表懒加载尚未渲染，滚动侧边栏继续找
                try:
                    page.mouse.move(200, 350)
                    page.mouse.wheel(0, 450)
                except Exception:
                    pass
                time.sleep(1.5)
        except Exception as e:
            logger.info("点击联系人 %s 异常: %s", name, str(e)[:100])
        time.sleep(random.uniform(1, 2))

    if not switched and search_and_open(page, name):
        time.sleep(random.uniform(1, 3))
        switched = verify_in_conversation(page, name)

    if not switched:
        return False, "未能切换到该好友会话（名字不在聊天列表，或页面结构变化）"

    if detect_rate_limit(page):
        return False, "检测到「操作频繁 / 安全验证」提示"

    input_box = page.locator('div[contenteditable="true"]').first
    try:
        if input_box.count() == 0 or input_box.bounding_box() is None:
            return False, "找不到聊天输入框"
        input_box.wait_for(state="visible", timeout=8000)
    except Exception:
        return False, "找不到聊天输入框"

    if dry_run:
        return True, "dry-run"

    try:
        if detect_rate_limit(page):
            return False, "发送前检测到验证提示"
        if not _type_and_send(page, input_box, msg_text):
            return False, "文字未能输入到输入框"
        if _wait_input_cleared(input_box, msg_text, wait=8):
            return True, "ok"
        logger.warning("未检测到消息发出，重试一次：%s", name)
        if detect_rate_limit(page):
            return False, "重试时检测到验证提示"
        if not _type_and_send(page, input_box, msg_text):
            return False, "重试时文字未能输入"
        if _wait_input_cleared(input_box, msg_text, wait=8):
            return True, "ok"
        return False, "发送后输入框未清空，消息可能未发出"
    except Exception as e:
        logger.info("向 %s 发送异常: %s", name, e)
        return False, f"发送异常: {e}"


def fetch_chat_contacts() -> dict:
    """从抖音私信页左侧聊天列表读取联系人（含火花天数），供网页端勾选。"""
    result = {"at": _now(), "names": [], "error": None}
    if not STATE_PATH.exists():
        result["error"] = "尚未上传登录态 state.json"
        return result

    browser = None
    try:
        p = sync_playwright().start()
        try:
            browser = p.chromium.launch(
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                ],
            )
            context = browser.new_context(
                storage_state=str(STATE_PATH),
                viewport={"width": 1366, "height": 768},
            )
            page = context.new_page()

            goto_ok = False
            for attempt in range(3):
                try:
                    page.goto(CHAT_URL, timeout=90000, wait_until="domcontentloaded")
                    goto_ok = True
                    break
                except Exception as e:
                    logger.info("获取联系人时第 %s 次打开页面失败: %s", attempt + 1, str(e)[:80])
                    time.sleep(5)
            if not goto_ok:
                result["error"] = "无法打开抖音私信页面"
                return result

            page.wait_for_timeout(15000)
            logged, why = check_login(page)
            if not logged:
                result["error"] = why
                return result

            extract_js = """
                () => {
                    const out = [];
                    const seen = new Set();
                    document.querySelectorAll('.conversationConversationItemtitle').forEach(t => {
                        const name = (t.textContent || '').trim();
                        if (!name || /^\\d{8,}$/.test(name) || seen.has(name)) return;
                        seen.add(name);

                        let streak = '';
                        let row = t.parentElement;
                        for (let i = 0; row && i < 10; i += 1) {
                            const titles = row.querySelectorAll('.conversationConversationItemtitle');
                            if (titles.length > 1) break;
                            const s = row.querySelector('.commonStreaknormalText');
                            if (s) {
                                streak = (s.textContent || '').trim();
                                break;
                            }
                            row = row.parentElement;
                        }

                        out.push({ name: name, streak: streak });
                    });
                    return out;
                }
            """

            collected_by_name: dict[str, dict] = {}
            for attempt in range(3):
                try:
                    page.wait_for_selector(".conversationConversationItemtitle", timeout=45000)
                except Exception:
                    logger.info("第 %s 次等待联系人列表超时", attempt + 1)

                stable = 0
                last_snapshot: list[dict] = []
                for _ in range(35):
                    data = []
                    for _sample in range(3):
                        data = page.evaluate(extract_js) or []
                        for item in data:
                            name = str(item.get("name", "")).strip()
                            if not name:
                                continue
                            old = collected_by_name.get(name)
                            if old is None or (not old.get("streak") and item.get("streak")):
                                collected_by_name[name] = item
                        page.wait_for_timeout(700)

                    changed = data != last_snapshot
                    last_snapshot = data

                    if changed:
                        stable = 0
                    else:
                        stable += 1
                        if stable >= 4 and collected_by_name:
                            break
                    try:
                        page.mouse.move(200, 350)
                        page.mouse.wheel(0, 300)
                    except Exception:
                        pass
                    page.wait_for_timeout(1800)

                if collected_by_name:
                    break
                try:
                    page.reload(wait_until="domcontentloaded", timeout=90000)
                    page.wait_for_timeout(12000)
                except Exception:
                    pass

            result["names"] = list(collected_by_name.values())
            logger.info("已读取聊天列表联系人 %s 个", len(result["names"]))
        finally:
            if browser:
                try:
                    browser.close()
                except Exception:
                    pass
            p.stop()
    except Exception as e:
        logger.error("获取联系人异常: %s", e)
        result["error"] = f"获取联系人异常: {e}"
    return result


def run_send(dry_run: bool = False, only_names: list[str] | None = None) -> dict:
    cfg = load_config()
    friends = cfg.get("friends") or []
    if only_names is not None:
        friends = [f for f in friends if f in only_names]
    messages = cfg.get("messages") or ["🔥"]
    max_n = int(cfg.get("max_friends_per_run", 20) or 20)
    gap_min = max(1, int(cfg.get("send_gap_min", 6) or 6))
    gap_max = max(gap_min, int(cfg.get("send_gap_max", 12) or 12))

    result = {
        "at": _now(),
        "dry_run": bool(dry_run),
        "ok": [],
        "failed": [],
        "logged_out": False,
        "rate_limited": False,
    }

    if not STATE_PATH.exists():
        result["failed"].append({"name": "_system", "reason": "尚未上传登录态 state.json"})
        return result

    targets = friends[:max_n] if max_n > 0 else friends
    browser = None
    try:
        p = sync_playwright().start()
        try:
            browser = p.chromium.launch(
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                ],
            )
            context = browser.new_context(
                storage_state=str(STATE_PATH),
                viewport={"width": 1366, "height": 768},
            )
            page = context.new_page()

            goto_ok = False
            for attempt in range(3):
                try:
                    page.goto(CHAT_URL, timeout=60000, wait_until="domcontentloaded")
                    goto_ok = True
                    break
                except Exception as e:
                    logger.info("第 %s 次打开页面失败: %s", attempt + 1, str(e)[:80])
                    time.sleep(5)
            if not goto_ok:
                result["failed"].append({"name": "_system", "reason": "无法打开抖音私信页面"})
                return result

            time.sleep(8)
            logged, why = check_login(page)
            if not logged:
                result["logged_out"] = True
                result["failed"].append({"name": "_system", "reason": why})
                _screenshot(page)
                return result

            if not targets:
                logger.info("未配置任何好友，跳过发送")
                return result

            logger.info("待发送好友 %s 人，dry_run=%s", len(targets), dry_run)
            for name in targets:
                msg = random.choice(messages)
                ok, why = send_to_contact(page, name, msg, dry_run)
                if ok:
                    result["ok"].append(name)
                    logger.info("已发送给 %s：%s", name, msg if not dry_run else "(干跑，未真实发送)")
                else:
                    result["failed"].append({"name": name, "reason": why})
                    logger.warning("发送给 %s 失败：%s", name, why)
                    if detect_rate_limit(page):
                        result["rate_limited"] = True
                        logger.warning("疑似触发限流，停止本轮")
                        break
                time.sleep(random.uniform(gap_min, gap_max))
        finally:
            if browser:
                try:
                    browser.close()
                except Exception:
                    pass
            p.stop()
    except Exception as e:
        logger.error("运行异常: %s", e)
        result["failed"].append({"name": "_system", "reason": f"运行异常: {e}"})
    return result
