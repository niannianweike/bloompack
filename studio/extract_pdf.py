#!/usr/bin/env python3
"""
Extract textbook metadata, TOC hints, and compact per-page text from any PDF.
Usage: python studio/extract_pdf.py <pdf_path> <out_json_path>
"""
import json
import re
import sys
import pymupdf


def clean(txt: str) -> str:
    txt = re.sub(r"\s+", " ", txt or "").strip()
    return txt


def main():
    if len(sys.argv) < 3:
        print("Usage: extract_pdf.py <pdf_path> <out_json_path>", file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]
    out_path = sys.argv[2]

    doc = pymupdf.open(pdf_path)
    total = len(doc)
    toc = doc.get_toc() or []
    pages = []
    toc_pages = []

    for i in range(total):
        raw = doc[i].get_text("text") or ""
        c = clean(raw)
        if ("目录" in c or "目 录" in c) and i < 15:
            toc_pages.append({"pdfPage": i + 1, "text": c[:1500]})
        pages.append({
            "pdfPage": i + 1,
            "charCount": len(c),
            "snippet": c[:360]
        })

    # Try to infer printed page offset (where unit 1 / lesson 1 starts)
    inferred_offset = 0
    for p in pages[:18]:
        if p["pdfPage"] >= 4 and ("第1单元" in p["snippet"] or "第一单元" in p["snippet"] or "第 1 单元" in p["snippet"]):
            if "目录" not in p["snippet"] and "目 录" not in p["snippet"]:
                inferred_offset = p["pdfPage"] - 1
                break

    result = {
        "totalPages": total,
        "inferredOffset": inferred_offset,
        "toc": [{"level": t[0], "title": t[1], "pdfPage": t[2]} for t in toc[:80]],
        "tocPages": toc_pages,
        "pages": pages
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(json.dumps({
        "ok": True,
        "totalPages": total,
        "inferredOffset": inferred_offset,
        "tocCount": len(result["toc"]),
        "tocPagesCount": len(toc_pages)
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
