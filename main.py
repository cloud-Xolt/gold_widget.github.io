# -*- coding: utf-8 -*-
"""
桌面金价悬浮窗  GoldWidget
--------------------------------------------------
零依赖：只用 Python 自带的 tkinter，无需 pip 安装任何东西。
适用于 Windows（推荐用 pythonw.exe 运行可隐藏黑窗）。

数据源：新浪财经免费行情接口
  - 沪金T+D (gds_AUTD)  上海黄金交易所，单位 元/克
  - 伦敦金 (hf_XAU)     国际现货黄金，单位 美元/盎司

功能：
  - 无边框小悬浮窗 / 始终置顶 / 鼠标拖动 / 双击切换主题
  - 自动刷新（5/10/30/60 秒可选）/ 立即刷新
  - 红涨绿跌（可在菜单切换为绿涨红跌）
  - 深色 / 浅色 / 透明 三种主题，透明度可调
  - 价格提醒（对沪金设上下限，越界弹窗提醒）
  - 记忆窗口位置、主题、透明度、刷新间隔等
  - 一键设置 / 取消开机自启
  - 右键菜单调出全部功能，含“调试信息”可查看原始数据

⚠️ 免责声明：行情数据仅供参考，可能与你的交易软件有差异，不构成任何投资建议。
"""

import json
import os
import threading
import time
import tkinter as tk
import tkinter.font as tkfont
from tkinter import messagebox, simpledialog
from urllib import request

# ----------------------------- 配置 -----------------------------
SINA_URL = "https://hq.sinajs.cn/list=gds_AUTD,hf_XAU"
HEADERS = {
    "Referer": "https://finance.sina.com.cn",   # 新浪接口必须带 Referer，否则 403
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
}
CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".gold_widget.json")

DEFAULT_CONFIG = {
    "x": 200, "y": 200,
    "theme": "dark",          # dark / light / transparent
    "alpha": 0.92,            # 透明度 0.3~1.0
    "interval": 10,           # 刷新间隔（秒）
    "topmost": True,
    "red_up": True,           # True=红涨绿跌(国内习惯)  False=绿涨红跌
    "alert_high": None,       # 沪金上限提醒
    "alert_low": None,        # 沪金下限提醒
}

THEMES = {
    "dark":        {"bg": "#1c1c20", "fg": "#e8e8e8", "sub": "#8a8a90"},
    "light":       {"bg": "#f4f4f6", "fg": "#202024", "sub": "#7a7a80"},
    "transparent": {"bg": "#010101", "fg": "#ffffff", "sub": "#cfcfcf"},  # bg 设为透明色
}
TRANSPARENT_COLOR = "#010101"   # 透明主题下被抠掉的颜色


# --------------------------- 数据抓取 ---------------------------
def fetch_raw():
    """请求新浪接口，返回原始 GBK 解码字符串。"""
    req = request.Request(SINA_URL, headers=HEADERS)
    with request.urlopen(req, timeout=6) as resp:
        return resp.read().decode("gbk", errors="ignore")


def parse_block(raw, key):
    """从原始响应里取出 var hq_str_key="...." 的内容并按逗号切分。"""
    tag = 'hq_str_%s="' % key
    i = raw.find(tag)
    if i < 0:
        return None
    i += len(tag)
    j = raw.find('"', i)
    if j < 0:
        return None
    body = raw[i:j].strip()
    if not body:
        return None
    return body.split(",")


def _to_float(s):
    try:
        return float(s)
    except (ValueError, TypeError):
        return None


def fetch_gold():
    """
    返回 dict：
      hu = {"price":..,"prev":..}  沪金T+D 元/克
      ldn= {"price":..,"prev":..}  伦敦金 美元/盎司
    解析失败的字段为 None。
    """
    raw = fetch_raw()
    result = {"hu": None, "ldn": None, "raw": raw}

    # 伦敦金 hf_XAU：现价=arr[0]，昨收=最后一个能转成数字的字段（通常是末位）
    a = parse_block(raw, "hf_XAU")
    if a and len(a) >= 2:
        price = _to_float(a[0])
        prev = _to_float(a[-1])
        if prev is None:
            prev = _to_float(a[-2]) if len(a) >= 2 else None
        if price is not None:
            result["ldn"] = {"price": price, "prev": prev}

    # 沪金T+D gds_AUTD：现价=arr[0]，昨收=arr[7]（带合理性校验，异常则不显示涨跌）
    b = parse_block(raw, "gds_AUTD")
    if b and len(b) >= 1:
        price = _to_float(b[0])
        prev = _to_float(b[7]) if len(b) > 7 else None
        if price is not None:
            if prev and prev > 0:
                chg = abs(price - prev) / prev
                if chg > 0.15:      # 涨跌幅 >15% 多半是字段对错了，宁可不显示
                    prev = None
            result["hu"] = {"price": price, "prev": prev}

    return result


# --------------------------- 主程序 ---------------------------
class GoldWidget:
    def __init__(self):
        self.cfg = self.load_config()
        self.last_data = None
        self.alerted_high = False
        self.alerted_low = False
        self._drag = (0, 0)

        self.root = tk.Tk()
        self.root.title("GoldWidget")
        self.root.overrideredirect(True)                    # 无边框
        self.root.attributes("-topmost", self.cfg["topmost"])
        self.root.attributes("-alpha", self.cfg["alpha"])
        self.root.geometry("+%d+%d" % (self.cfg["x"], self.cfg["y"]))

        big = tkfont.Font(family="Microsoft YaHei", size=13, weight="bold")
        small = tkfont.Font(family="Microsoft YaHei", size=9)

        self.frame = tk.Frame(self.root, padx=12, pady=8)
        self.frame.pack()

        self.lbl_hu = tk.Label(self.frame, font=big, anchor="w", justify="left")
        self.lbl_hu.pack(fill="x")
        self.lbl_ldn = tk.Label(self.frame, font=big, anchor="w", justify="left")
        self.lbl_ldn.pack(fill="x")
        self.lbl_time = tk.Label(self.frame, font=small, anchor="w", justify="left")
        self.lbl_time.pack(fill="x")

        # 绑定事件：拖动 / 双击换主题 / 右键菜单
        for w in (self.root, self.frame, self.lbl_hu, self.lbl_ldn, self.lbl_time):
            w.bind("<Button-1>", self.on_press)
            w.bind("<B1-Motion>", self.on_drag)
            w.bind("<Double-Button-1>", lambda e: self.cycle_theme())
            w.bind("<Button-3>", self.show_menu)

        self.apply_theme()
        self.lbl_time.config(text="加载中…")
        self.refresh_async()
        self.schedule()
        self.root.protocol("WM_DELETE_WINDOW", self.quit)

    # ---------- 配置读写 ----------
    def load_config(self):
        cfg = dict(DEFAULT_CONFIG)
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception:
            pass
        return cfg

    def save_config(self):
        try:
            self.cfg["x"] = self.root.winfo_x()
            self.cfg["y"] = self.root.winfo_y()
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(self.cfg, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    # ---------- 主题 ----------
    def apply_theme(self):
        t = THEMES[self.cfg["theme"]]
        bg = t["bg"]
        if self.cfg["theme"] == "transparent":
            self.root.attributes("-transparentcolor", TRANSPARENT_COLOR)
        else:
            try:
                self.root.attributes("-transparentcolor", "")
            except tk.TclError:
                pass
        for w in (self.root, self.frame, self.lbl_hu, self.lbl_ldn, self.lbl_time):
            w.config(bg=bg)
        self.lbl_time.config(fg=t["sub"])
        self.root.attributes("-alpha", self.cfg["alpha"])
        self.render()  # 重新着色涨跌

    def cycle_theme(self):
        order = ["dark", "light", "transparent"]
        i = (order.index(self.cfg["theme"]) + 1) % len(order)
        self.cfg["theme"] = order[i]
        self.apply_theme()
        self.save_config()

    def up_color(self):
        return "#ff4d4f" if self.cfg["red_up"] else "#21c46b"

    def down_color(self):
        return "#21c46b" if self.cfg["red_up"] else "#ff4d4f"

    # ---------- 拖动 ----------
    def on_press(self, e):
        self._drag = (e.x_root - self.root.winfo_x(), e.y_root - self.root.winfo_y())

    def on_drag(self, e):
        self.root.geometry("+%d+%d" % (e.x_root - self._drag[0], e.y_root - self._drag[1]))

    # ---------- 渲染 ----------
    def fmt_line(self, name, unit, item):
        if not item:
            return "%s  --" % name, None
        price = item["price"]
        prev = item.get("prev")
        if prev:
            diff = price - prev
            pct = diff / prev * 100
            arrow = "▲" if diff > 0 else ("▼" if diff < 0 else "•")
            txt = "%s  %.2f  %s%+.2f (%+.2f%%)  %s" % (name, price, arrow, diff, pct, unit)
            color = self.up_color() if diff > 0 else (self.down_color() if diff < 0 else None)
            return txt, color
        return "%s  %.2f  %s" % (name, price, unit), None

    def render(self):
        t = THEMES[self.cfg["theme"]]
        d = self.last_data
        if not d:
            return
        hu_txt, hu_c = self.fmt_line("沪金T+D", "元/克", d.get("hu"))
        ldn_txt, ldn_c = self.fmt_line("伦敦金", "$/oz", d.get("ldn"))
        self.lbl_hu.config(text=hu_txt, fg=hu_c or t["fg"])
        self.lbl_ldn.config(text=ldn_txt, fg=ldn_c or t["fg"])

    # ---------- 刷新 ----------
    def refresh_async(self):
        threading.Thread(target=self._do_fetch, daemon=True).start()

    def _do_fetch(self):
        try:
            data = fetch_gold()
            self.root.after(0, self.on_data, data)
        except Exception as ex:
            self.root.after(0, self.on_error, ex)

    def on_data(self, data):
        self.last_data = data
        self.render()
        self.lbl_time.config(text="更新 " + time.strftime("%H:%M:%S"))
        self.check_alert(data)

    def on_error(self, ex):
        self.lbl_time.config(text="获取失败：%s" % str(ex)[:30])

    def schedule(self):
        self.refresh_async()
        self.root.after(max(2, int(self.cfg["interval"])) * 1000, self.schedule)

    # ---------- 价格提醒 ----------
    def check_alert(self, data):
        hu = data.get("hu")
        if not hu:
            return
        p = hu["price"]
        hi, lo = self.cfg["alert_high"], self.cfg["alert_low"]
        if hi is not None and p >= hi and not self.alerted_high:
            self.alerted_high = True
            messagebox.showinfo("金价提醒", "沪金T+D 已涨破 %.2f（当前 %.2f 元/克）" % (hi, p))
        if hi is not None and p < hi:
            self.alerted_high = False
        if lo is not None and p <= lo and not self.alerted_low:
            self.alerted_low = True
            messagebox.showinfo("金价提醒", "沪金T+D 已跌破 %.2f（当前 %.2f 元/克）" % (lo, p))
        if lo is not None and p > lo:
            self.alerted_low = False

    def set_alert(self):
        try:
            hi = simpledialog.askfloat("上限提醒", "沪金T+D 涨破多少元/克时提醒？\n（留空/取消则不设）",
                                       parent=self.root)
            lo = simpledialog.askfloat("下限提醒", "沪金T+D 跌破多少元/克时提醒？\n（留空/取消则不设）",
                                       parent=self.root)
            self.cfg["alert_high"] = hi
            self.cfg["alert_low"] = lo
            self.alerted_high = self.alerted_low = False
            self.save_config()
            messagebox.showinfo("已设置", "上限：%s  下限：%s" % (hi, lo))
        except Exception:
            pass

    # ---------- 透明度 / 间隔 ----------
    def set_alpha(self, v):
        self.cfg["alpha"] = max(0.3, min(1.0, v))
        self.root.attributes("-alpha", self.cfg["alpha"])
        self.save_config()

    def set_interval(self, sec):
        self.cfg["interval"] = sec
        self.save_config()

    def toggle_topmost(self):
        self.cfg["topmost"] = not self.cfg["topmost"]
        self.root.attributes("-topmost", self.cfg["topmost"])
        self.save_config()

    def toggle_color(self):
        self.cfg["red_up"] = not self.cfg["red_up"]
        self.render()
        self.save_config()

    # ---------- 开机自启（写入启动文件夹 .bat） ----------
    def startup_bat_path(self):
        startup = os.path.join(os.environ.get("APPDATA", ""),
                               r"Microsoft\Windows\Start Menu\Programs\Startup")
        return os.path.join(startup, "GoldWidget.bat")

    def enable_autostart(self):
        try:
            script = os.path.abspath(__file__)
            pyw = os.path.join(os.path.dirname(os.sys.executable), "pythonw.exe")
            if not os.path.exists(pyw):
                pyw = "pythonw"
            with open(self.startup_bat_path(), "w", encoding="utf-8") as f:
                f.write('@echo off\nstart "" "%s" "%s"\n' % (pyw, script))
            messagebox.showinfo("开机自启", "已设置开机自动启动。")
        except Exception as ex:
            messagebox.showerror("失败", str(ex))

    def disable_autostart(self):
        try:
            p = self.startup_bat_path()
            if os.path.exists(p):
                os.remove(p)
            messagebox.showinfo("开机自启", "已取消开机自动启动。")
        except Exception as ex:
            messagebox.showerror("失败", str(ex))

    # ---------- 调试 ----------
    def show_debug(self):
        raw = (self.last_data or {}).get("raw", "（暂无数据）")
        win = tk.Toplevel(self.root)
        win.title("调试 - 原始数据")
        win.attributes("-topmost", True)
        txt = tk.Text(win, width=80, height=12, wrap="word")
        txt.pack(fill="both", expand=True)
        txt.insert("1.0", raw)
        tk.Label(win, fg="#888",
                 text="字段对不上时：沪金现价=gds_AUTD[0]，昨收=[7]；伦敦金现价=hf_XAU[0]，昨收=末位"
                 ).pack()

    # ---------- 右键菜单 ----------
    def show_menu(self, e):
        m = tk.Menu(self.root, tearoff=0)
        m.add_command(label="立即刷新", command=self.refresh_async)

        sub_i = tk.Menu(m, tearoff=0)
        for s in (5, 10, 30, 60):
            sub_i.add_command(label="%d 秒%s" % (s, "  ✓" if self.cfg["interval"] == s else ""),
                              command=lambda x=s: self.set_interval(x))
        m.add_cascade(label="刷新间隔", menu=sub_i)

        sub_a = tk.Menu(m, tearoff=0)
        sub_a.add_command(label="更不透明 +",
                          command=lambda: self.set_alpha(self.cfg["alpha"] + 0.1))
        sub_a.add_command(label="更透明 -",
                          command=lambda: self.set_alpha(self.cfg["alpha"] - 0.1))
        m.add_cascade(label="透明度", menu=sub_a)

        m.add_command(label="切换主题（深/浅/透明）", command=self.cycle_theme)
        m.add_command(label="始终置顶  %s" % ("✓" if self.cfg["topmost"] else "✗"),
                      command=self.toggle_topmost)
        m.add_command(label="涨跌配色：%s" % ("红涨绿跌" if self.cfg["red_up"] else "绿涨红跌"),
                      command=self.toggle_color)
        m.add_separator()
        m.add_command(label="设置价格提醒…", command=self.set_alert)
        m.add_separator()
        m.add_command(label="设置开机自启", command=self.enable_autostart)
        m.add_command(label="取消开机自启", command=self.disable_autostart)
        m.add_command(label="调试信息…", command=self.show_debug)
        m.add_separator()
        m.add_command(label="退出", command=self.quit)
        m.tk_popup(e.x_root, e.y_root)

    def quit(self):
        self.save_config()
        self.root.destroy()

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    GoldWidget().run()