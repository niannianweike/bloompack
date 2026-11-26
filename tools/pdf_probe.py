"""看看 PDF 是什么货色：页数、有没有文字层、能不能渲染。

用法：
  python tools/pdf_probe.py "科学一年级上册.pdf"
  python tools/pdf_probe.py "科学一年级上册.pdf" --render 1-12 --dpi 110
"""
import argparse
import os
import sys

# Windows 控制台默认 GBK，中文/特殊字符会炸，强制 UTF-8
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

import pymupdf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf')
    ap.add_argument('--render', default=None, help='页码区间，如 1-12 或 3,5,7')
    ap.add_argument('--dpi', type=int, default=110)
    args = ap.parse_args()

    doc = pymupdf.open(args.pdf)
    print(f'pages={doc.page_count}')
    print(f'metadata={doc.metadata}')

    text_pages = 0
    for i, page in enumerate(doc):
        t = page.get_text().strip()
        if t:
            text_pages += 1
            if text_pages <= 3:
                print(f'--- 第 {i+1} 页有文字层 ---')
                print(t[:400])
    print(f'有文字层的页数={text_pages}/{doc.page_count}')

    # 每页图片数、尺寸，判断是不是扫描件
    for i in range(min(3, doc.page_count)):
        page = doc[i]
        imgs = page.get_images(full=True)
        r = page.rect
        print(f'第 {i+1} 页: {r.width:.0f}x{r.height:.0f} pt, 图 {len(imgs)} 张, 文字 {len(page.get_text())} 字')

    if args.render:
        # 输出固定在项目 review/pages/ 下（原 --out 参数因路径穿越风险移除）
        base = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
        out = os.path.join(base, 'review', 'pages', os.path.splitext(os.path.basename(args.pdf))[0])
        os.makedirs(out, exist_ok=True)
        spec = args.render
        if '-' in spec and ',' not in spec:
            a, b = spec.split('-')
            nums = range(int(a), int(b) + 1)
        else:
            nums = [int(x) for x in spec.split(',')]
        for n in nums:
            if n < 1 or n > doc.page_count:
                continue
            page = doc[n - 1]
            pix = page.get_pixmap(dpi=args.dpi)
            fp = os.path.join(out, f'p{n:03d}.png')
            pix.save(fp)
            print(f'render {fp}  {pix.width}x{pix.height}')


if __name__ == '__main__':
    sys.exit(main())
