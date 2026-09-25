"""不依赖 Spotlight 的 EXIF 读取。

为什么需要它：体检原先用 `mdls` 取曝光 / 光圈 / ISO / 机身，而那要求文件已经被
Spotlight 索引。点号目录、外置盘、网络盘、以及**刚拷贝进来的文件**都会静默返回
`(null)`。后果不是「少几个数字」——曝光跨度一旦为空，包围曝光就会和连拍分不开，
而按摄鲸的规则这两类的处置完全相反（包围曝光一律全留，连拍可进剔除建议）。

ARW / NEF / CR2 / DNG 都是 TIFF 结构，EXIF 就在文件头部，直接读既准确又快，
也不需要文件系统之外的任何东西。JPEG 走 APP1 段。

只读，不改任何文件。
"""

import struct

# ---- TIFF 标签
TAG_MAKE = 0x010F
TAG_MODEL = 0x0110
TAG_DATETIME = 0x0132
TAG_EXIF_IFD = 0x8769
TAG_EXPOSURE_TIME = 0x829A
TAG_FNUMBER = 0x829D
TAG_ISO_SPEED_RATINGS = 0x8827
TAG_ISO_SPEED = 0x8833
TAG_DATETIME_ORIGINAL = 0x9003
TAG_FOCAL_LENGTH = 0x920A
TAG_SUB_IFD = 0x014A

_TYPE_SIZE = {
    1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
}

# IFD 里指针型字段的偏移量可能落在文件任何位置，但 EXIF 实际总在头部附近。
_HEAD_BYTES = 4 * 1024 * 1024


def _type_size(typ):
    return _TYPE_SIZE.get(typ, 0)


def _read_entries(buf, offset, endian):
    """读一个 IFD，返回 [(tag, typ, count, raw_bytes)]。越界即停止。"""
    if offset <= 0 or offset + 2 > len(buf):
        return []
    (count,) = struct.unpack_from(endian + "H", buf, offset)
    base = offset + 2
    entries = []
    for i in range(count):
        p = base + i * 12
        if p + 12 > len(buf):
            break
        tag, typ, cnt = struct.unpack_from(endian + "HHI", buf, p)
        size = _type_size(typ) * cnt
        if size == 0:
            continue
        if size <= 4:
            raw = buf[p + 8:p + 8 + size]
        else:
            (value_offset,) = struct.unpack_from(endian + "I", buf, p + 8)
            if value_offset + size > len(buf):
                continue
            raw = buf[value_offset:value_offset + size]
        entries.append((tag, typ, cnt, raw))
    return entries


def _as_float_be(typ, raw, endian):
    if not raw:
        return None
    try:
        if typ == 5:
            n, d = struct.unpack_from(endian + "II", raw, 0)
            return None if d == 0 else n / d
        if typ == 10:
            n, d = struct.unpack_from(endian + "ii", raw, 0)
            return None if d == 0 else n / d
        if typ == 3:
            return float(struct.unpack_from(endian + "H", raw, 0)[0])
        if typ == 4:
            return float(struct.unpack_from(endian + "I", raw, 0)[0])
        if typ == 9:
            return float(struct.unpack_from(endian + "i", raw, 0)[0])
        if typ == 1:
            return float(raw[0])
    except struct.error:
        return None
    
    return None


def _as_text(raw):
    if not raw:
        return None
    text = raw.split(b"\x00")[0].decode("utf-8", "replace").strip()
    return text or None


def _find_value(entries, tag, endian):
    for t, typ, _cnt, raw in entries:
        if t != tag:
            continue
        if typ == 2:
            return _as_text(raw)
        return _as_float_be(typ, raw, endian)
    return None


def _tiff_base(buf):
    """定位 TIFF 头。JPEG 要先找到 APP1 的 Exif 段。"""
    if buf[:2] == b"\xff\xd8":
        i = 2
        while i + 4 < len(buf):
            if buf[i] != 0xFF:
                i += 1
                continue
            marker = buf[i + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            seg_len = struct.unpack_from(">H", buf, i + 2)[0]
            if marker == 0xE1 and buf[i + 4:i + 10] == b"Exif\x00\x00":
                return i + 10
            i += 2 + seg_len
        return None
    if buf[:2] in (b"II", b"MM"):
        return 0
    return None


def read_exif(path):
    """读一个照片文件的常用 EXIF。

    @returns dict，键为 make / model / datetime / exposure / fnumber / iso / focal；
             任何一项读不到就是 None。**不会抛异常**——体检不该因为一个坏文件中断。
    """
    out = {
        "make": None, "model": None, "datetime": None,
        "exposure": None, "fnumber": None, "iso": None, "focal": None,
    }
    try:
        with open(path, "rb") as fh:
            buf = fh.read(_HEAD_BYTES)
    except OSError:
        return out

    base = _tiff_base(buf)
    if base is None or base + 8 > len(buf):
        return out

    order = buf[base:base + 2]
    if order == b"II":
        endian = "<"
    elif order == b"MM":
        endian = ">"
    else:
        return out

    try:
        (magic,) = struct.unpack_from(endian + "H", buf, base + 2)
        (ifd0_offset,) = struct.unpack_from(endian + "I", buf, base + 4)
    except struct.error:
        return out
    if magic != 42:
        return out

    ifd0 = _read_entries(buf, base + ifd0_offset, endian)
    out["make"] = _find_value(ifd0, TAG_MAKE, endian)
    out["model"] = _find_value(ifd0, TAG_MODEL, endian)
    out["datetime"] = _find_value(ifd0, TAG_DATETIME, endian)

    exif_ptr = _find_value(ifd0, TAG_EXIF_IFD, endian)
    if exif_ptr:
        exif = _read_entries(buf, base + int(exif_ptr), endian)
        out["exposure"] = _find_value(exif, TAG_EXPOSURE_TIME, endian)
        out["fnumber"] = _find_value(exif, TAG_FNUMBER, endian)
        out["iso"] = _find_value(exif, TAG_ISO_SPEED_RATINGS, endian)
        if out["iso"] is None:
            out["iso"] = _find_value(exif, TAG_ISO_SPEED, endian)
        out["focal"] = _find_value(exif, TAG_FOCAL_LENGTH, endian)
        original = _find_value(exif, TAG_DATETIME_ORIGINAL, endian)
        if isinstance(original, str) and original:
            out["datetime"] = original

    # 有些机型的 EXIF 在 SubIFD 里（DNG 常见），主 IFD 取不到时再下一层。
    if out["fnumber"] is None or out["exposure"] is None:
        for tag, _typ, _cnt, raw in ifd0:
            if tag != TAG_SUB_IFD or len(raw) < 4:
                continue
            for k in range(0, min(len(raw), 16), 4):
                try:
                    (sub_off,) = struct.unpack_from(endian + "I", raw, k)
                except struct.error:
                    break
                sub = _read_entries(buf, base + sub_off, endian)
                if out["exposure"] is None:
                    out["exposure"] = _find_value(sub, TAG_EXPOSURE_TIME, endian)
                if out["fnumber"] is None:
                    out["fnumber"] = _find_value(sub, TAG_FNUMBER, endian)
                if out["iso"] is None:
                    out["iso"] = _find_value(sub, TAG_ISO_SPEED_RATINGS, endian)
                if out["iso"] is None:
                    out["iso"] = _find_value(sub, TAG_ISO_SPEED, endian)
            break

    return out
