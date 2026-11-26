"""把 PDF 全文导成一个 txt，顺便把每页的图片数记下来（判断哪些页是插图页）。

用法（全文直接打到标准输出，由使用者重定向落盘，工具本身不写文件）：
  python tools/pdf_text.py "科学一年级上册.pdf" > review/科学一年级上册-text.txt
  python tools/pdf_text.py "科学一年级上册.pdf" --pages 4-12
"""
import argparse
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

import pymupdf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf')
    ap.add_argument('--pages', default=None, help='页码区间，如 4-12（摘要走 stderr，不混进导出文本）')
    args = ap.parse_args()

    doc = pymupdf.open(args.pdf)
    nums = None
    if args.pages:
        a, _, b = args.pages.partition('-')
        nums = range(int(a), int(b or a) + 1)

    chunks = []
    for i, page in enumerate(doc, start=1):
        n_imgs = len(page.get_images(full=True))
        line = f'\n========== 第 {i} 页（图 {n_imgs} 张）==========\n'
        chunks.append(line + page.get_text().strip())
    sys.stdout.write('\n'.join(chunks) + '\n')

    if nums:
        for n in nums:
            if 1 <= n <= doc.page_count:
                page = doc[n - 1]
                print(f'\n===== 第 {n} 页 =====', file=sys.stderr)
                print(page.get_text().strip(), file=sys.stderr)


if __name__ == '__main__':
    sys.exit(main())
