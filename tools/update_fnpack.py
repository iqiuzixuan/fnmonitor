#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
update_fnpack.py - 把新构建的 fpk 写入 FnDepot 应用源索引 fnpack.json
=====================================================================
在 build.sh / build.ps1 产出 fnmonitor-<版本>-x86.fpk / -arm.fpk 后执行：

    python3 tools/update_fnpack.py            # 版本号与更新日志取自 manifest
    python3 tools/update_fnpack.py --keep 5   # 只保留最近 5 个版本（默认 10）

做的事：
  1. 读取 manifest 的 version 与 changelog 中本版本那一段；
  2. 计算两个 fpk 的 sha256 与字节数（FnDepot 存在 sha256 时会强制校验）；
  3. 在 releases 下新增 / 覆盖该版本条目，download_url 指向本仓库 Releases；
  4. 按版本号倒序保留最近 N 个版本。

注意：已发布的「版本号 + 架构」文件应视为不可变——内容变了就发新版本号，
不要静默替换同版本的 fpk（FnDepot 编写规范要求）。
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "iqiuzixuan/fnmonitor"


def read_manifest():
    with open(os.path.join(ROOT, "manifest"), encoding="utf-8") as f:
        text = f.read()
    version = re.search(r"^version=(.+)$", text, re.M).group(1).strip()
    m = re.search(r"^changelog=(.*)$", text, re.M)
    changelog = m.group(1).strip() if m else ""
    # manifest 的 changelog 累积了历史版本（以 <br><br> 分隔），只取当前版本那一段
    part = changelog.split("<br><br>")[0] if changelog else ""
    return version, part


def file_info(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest(), os.path.getsize(path)


def vkey(v):
    return tuple(int(x) if x.isdigit() else 0 for x in re.split(r"[.\-]", v))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", type=int, default=10, help="保留最近 N 个版本")
    args = ap.parse_args()

    version, changelog = read_manifest()
    packages = {}
    for plat in ("x86", "arm"):
        name = "fnmonitor-%s-%s.fpk" % (version, plat)
        path = os.path.join(ROOT, name)
        if not os.path.exists(path):
            sys.exit("缺少 %s，请先运行 build.sh / build.ps1" % name)
        sha, size = file_info(path)
        packages[plat] = {
            "download_url": "https://github.com/%s/releases/download/%s/%s" % (REPO, version, name),
            "sha256": sha,
            "size": size,
        }
        print("%s  %s  %d bytes" % (name, sha, size))

    idx_path = os.path.join(ROOT, "fnpack.json")
    with open(idx_path, encoding="utf-8") as f:
        idx = json.load(f)
    app = idx["apps"]["fnmonitor"]
    rel = app.setdefault("releases", {})
    rel[version] = {
        "changelog": changelog,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S+08:00", time.localtime()),
        "os_min_version": "0.9.0",
        "packages": packages,
    }
    keep = sorted(rel.keys(), key=vkey, reverse=True)[: max(1, args.keep)]
    app["releases"] = {k: rel[k] for k in keep}
    with open(idx_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(idx, ensure_ascii=False, indent=1) + "\n")
    print("fnpack.json 已写入版本 %s（共保留 %d 个版本）" % (version, len(keep)))


if __name__ == "__main__":
    main()
