#!/usr/bin/env python3
"""2차지식 문서의 출처 태그를 원본과 자동 대조한다 (daesan-2nd-knowledge 스킬의 '저장 전 검증' 보조 도구).

검사 항목
- 출처 실존: `(출처: ...)`의 파일이 raw/sources·wiki 안에 있는지. `통화기록 <고객사>_<14자리>`는
  raw/sources/calls 에서 끝의 14자리로 찾는다.
- 숫자 일치: 인용 문장 속 숫자가 원본에 있는지.
- 내용 겹침: 문장의 한글 단어가 원본에 얼마나 나오는지 (기본 0.45 미만이면 플래그).
- 개인정보: 전화번호 형태 문자열이 남아 있는지.

한계: 단어·숫자 겹침만 본다. 겹치지만 뜻이 뒤집힌 문장은 못 잡으므로, 플래그된 문장은 사람이
원본을 열어 판정해야 한다. 공개 표준(KS 등)처럼 위키 밖 자료는 대조하지 못한다.

사용 예
  python3 -I scripts/verify_2nd_knowledge_citations.py                # 기본 위키의 2차지식 전체
  python3 -I scripts/verify_2nd_knowledge_citations.py --flags 파일.md  # 특정 문서, 플래그 문장 출력
  python3 -I scripts/verify_2nd_knowledge_citations.py --out report.json

종료 코드: 출처 미확인 또는 전화번호 잔존이 있으면 1, 아니면 0.
"""
import argparse
import glob
import json
import os
import re
import sys
import unicodedata

DEFAULT_ROOT = "/Users/zart/LLMWiki/daesan-wiki-sync"
PHONE_RE = re.compile(r"01[016789]-?\d{3,4}-?\d{4}|_0\d{8,10}_")


def nf(s):
    return unicodedata.normalize("NFC", s)


def build_index(root):
    idx = {}
    for base in ("raw/sources", "wiki"):
        for p in glob.glob(os.path.join(root, base, "**", "*.md"), recursive=True):
            idx.setdefault(nf(os.path.basename(p)), []).append(p)
    calls = {}
    for p in glob.glob(os.path.join(root, "raw/sources/calls", "*.md")):
        m = re.search(r"_(\d{14})\.md$", nf(p))
        if m:
            calls.setdefault(m.group(1), []).append(p)
    return idx, calls


def resolve(tag, idx, calls):
    tag = nf(tag.strip().rstrip("."))
    m = re.search(r"통화기록 [^_\s]*_(\d{14})", tag)
    if m:
        hit = calls.get(m.group(1))
        return hit[0] if hit else None
    if "wiki/" in tag or "raw/" in tag:
        tag = os.path.basename(tag)
    stem = re.sub(r"\.md.*$", "", tag).strip()
    name = stem + ".md"
    if name in idx:
        return idx[name][0]
    return None


def split_sources(tag):
    srcs = [x for x in re.split(r"[;,]\s*", tag) if x.strip()]
    srcs = [x for x in srcs if not re.fullmatch(r"\s*[.…]+\s*", x)]  # 설명문 속 "(출처: ...)" 자리표시 제외
    return [x for x in srcs if "." in x or "통화기록" in x or "_" in x]


def check_file(path, idx, calls, threshold):
    t = nf(open(path, encoding="utf-8").read())
    body = t.split("---", 2)[-1]
    stats = dict(cited=0, unresolved=0, num_miss=0, low_cov=0, phones=len(PHONE_RE.findall(t)),
                 typed=bool(re.search(r"^## 타입:\s*(comparison|synthesis)", body, re.M)),
                 inferred=body.count("(추론"), flags=[], unresolved_names=[])
    for line in body.splitlines():
        if "출처" not in line:
            continue
        for m in re.finditer(r"(.*?)\(출처[:：]\s*((?:[^()]|\([^)]*\))*)\)", line):
            text, tag = m.group(1).strip(), m.group(2)
            srcs = split_sources(tag)
            if not srcs:
                continue
            stats["cited"] += 1
            content, missing = "", []
            for s in srcs:
                p = resolve(s, idx, calls)
                if p:
                    content += nf(open(p, encoding="utf-8", errors="ignore").read())
                else:
                    missing.append(s.strip()[:80])
            if missing:
                stats["unresolved_names"].extend(missing)
            if not content:
                stats["unresolved"] += 1
                continue
            clean = re.sub(r"\(출처[^)]*\)", "", text)
            nums = set(re.findall(r"\d+(?:[.,]\d+)?", clean))
            words = set(re.findall(r"[가-힣]{2,}", clean))
            flat = re.sub(r"\s+", "", content)
            miss_nums = sorted(n for n in nums if n not in content)
            cov = (sum(1 for w in words if w in flat) / len(words)) if words else 1.0
            if miss_nums:
                stats["num_miss"] += 1
            if cov < threshold:
                stats["low_cov"] += 1
            if miss_nums or cov < threshold:
                stats["flags"].append(dict(text=text[:240], missing_numbers=miss_nums,
                                           coverage=round(cov, 2), sources=[s.strip()[:60] for s in srcs]))
    stats["unresolved_names"] = sorted(set(stats["unresolved_names"]))
    return stats


def default_files(root):
    q = os.path.join(root, "wiki/queries")
    out = []
    for f in sorted(os.listdir(q)):
        if not (nf(f).startswith("2차-지식-생성-") and f.endswith(".md")):
            continue
        p = os.path.join(q, f)
        if "status: regenerate-candidate" in open(p, encoding="utf-8").read(2000):
            continue
        out.append(p)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("files", nargs="*", help="검사할 2차지식 문서 (생략 시 wiki/queries 의 2차-지식-생성-* 전체, 재생성 후보 제외)")
    ap.add_argument("--root", default=DEFAULT_ROOT, help="위키 프로젝트 루트")
    ap.add_argument("--threshold", type=float, default=0.45, help="내용 겹침 플래그 기준 (기본 0.45)")
    ap.add_argument("--flags", action="store_true", help="플래그된 문장을 출력")
    ap.add_argument("--out", help="JSON 보고서 저장 경로")
    a = ap.parse_args()

    idx, calls = build_index(a.root)
    files = a.files or default_files(a.root)
    report, bad = {}, False
    for f in files:
        s = check_file(f, idx, calls, a.threshold)
        name = nf(os.path.basename(f))
        report[name] = s
        bad |= s["unresolved"] > 0 or s["phones"] > 0
        print(f"{name[:46]:48} cited={s['cited']:3} unresolved={s['unresolved']:2} "
              f"numMiss={s['num_miss']:2} lowCov={s['low_cov']:2} phones={s['phones']:2} "
              f"typed={'Y' if s['typed'] else 'N'} 추론={s['inferred']}")
        if a.flags:
            for u in s["unresolved_names"]:
                print(f"    [출처 없음] {u}")
            for fl in s["flags"]:
                print(f"    [{fl['coverage']}] {fl['text'][:160]}  missing={fl['missing_numbers']}  <= {fl['sources'][0]}")
    if a.out:
        with open(a.out, "w", encoding="utf-8") as fp:
            json.dump(report, fp, ensure_ascii=False, indent=1)
    print("\n플래그는 '의심'일 뿐이다. 원본을 열어 직접 판정할 것. 위키 밖 공개 자료는 대조되지 않는다.")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
