import frida

JS = r"""
const MODULE = "SB-Win64-Shipping.exe";
const P1 = "44 89 42 6C 45 84 D2 74 ?? 41 8B 01 2B C5";
const P2 = "41 8B 47 38 41 2B C4 ?? 39 ?? 38 0F 42 ?? ?? 89 ?? ?? 41 39 57 38";
const CAVE_PATTERN = "CC CC CC CC CC CC CC CC CC CC CC CC CC CC CC CC";

function rel32(from, to) {
    return to.sub(from).toInt32();
}

function allocNear(addr) {
    const k32 = Process.getModuleByName("kernel32.dll");
    const VirtualAlloc = new NativeFunction(
        k32.getExportByName("VirtualAlloc"), "pointer",
        ["pointer", "size_t", "uint32", "uint32"]);
    // Search outwards for a free page within rel32 range. VirtualAlloc at an
    // occupied address simply fails, so this is safe.
    for (let i = 1; i < 0x700; i++) {
        for (const sign of [-1, 1]) {
            const candidate = addr.add(sign * i * 0x100000);
            const page = VirtualAlloc(candidate, 0x1000, 0x3000, 0x40);
            if (!page.isNull()) return page;
        }
    }
    return null;
}

function patchOne(mod, pattern, cavePrefix) {
    const found = Memory.scanSync(mod.base, mod.size, pattern);
    if (found.length === 0) return { ok: false, error: "pattern-not-found" };
    const addr = found[0].address;
    const cave = allocNear(addr);
    if (cave === null) return { ok: false, error: "no-near-page" };

    const code = new Uint8Array(cavePrefix.length + 5);
    code.set(cavePrefix, 0);
    code[cavePrefix.length] = 0xE9;
    const rel = rel32(cave.add(cavePrefix.length + 5), addr.add(7));
    code[cavePrefix.length + 1] = rel & 0xFF;
    code[cavePrefix.length + 2] = (rel >> 8) & 0xFF;
    code[cavePrefix.length + 3] = (rel >> 16) & 0xFF;
    code[cavePrefix.length + 4] = (rel >> 24) & 0xFF;

    Memory.protect(cave, 0x1000, "rwx");
    Memory.protect(addr, 7, "rwx");
    cave.writeByteArray(code);
    const patch = new Uint8Array(7);
    patch[0] = 0xE9;
    const relPatch = rel32(addr.add(5), cave);
    patch[1] = relPatch & 0xFF;
    patch[2] = (relPatch >> 8) & 0xFF;
    patch[3] = (relPatch >> 16) & 0xFF;
    patch[4] = (relPatch >> 24) & 0xFF;
    patch[5] = 0x90;
    patch[6] = 0x90;
    addr.writeByteArray(patch);
    Memory.protect(addr, 7, "r-x");
    return { ok: true, address: addr.toString(), cave: cave.toString() };
}

rpc.exports = {
    apply: function () {
        const mod = Process.findModuleByName(MODULE);
        if (mod === null) return { ok: false, error: "module-not-found" };
        // aobitemdec_1: actual ammo/usable item consumption.
        const p1 = new Uint8Array([
            0x45,0x84,0xD2,             // test r10b,r10b
            0x74,0x0C,                   // je code (after add-back block)
            0x41,0x83,0xF8,0x00,         // cmp r8d,0
            0x7E,0x06,                   // jle code (after add-back block)
            0x41,0x01,0xE8,             // add r8d,ebp
            0x41,0x01,0x29,             // add [r9],ebp
            0x44,0x89,0x42,0x6C,         // mov [rdx+6C],r8d
            0x45,0x84,0xD2              // test r10b,r10b
        ]);
        // aobitemdec_2: inventory display amount.
        const p2 = new Uint8Array([
            0x83,0xFA,0x00,             // cmp edx,0
            0x7E,0x0C,                   // jle code
            0x45,0x01,0x67,0x34,         // add [r15+34],r12d
            0x45,0x01,0x67,0x38,         // add [r15+38],r12d
            0x41,0x8B,0x57,0x34,         // mov edx,[r15+34]
            0x41,0x8B,0x47,0x38,         // mov eax,[r15+38]
            0x44,0x29,0xE0              // sub eax,r12d
        ]);
        const r1 = patchOne(mod, P1, p1);
        const r2 = patchOne(mod, P2, p2);
        return { ok: r1.ok && r2.ok, p1: r1, p2: r2 };
    }
};
"""


def apply_ammo_patch():
    session = frida.attach("SB-Win64-Shipping.exe")
    try:
        script = session.create_script(JS)
        messages = []

        def on_message(message, data):
            messages.append(message)

        script.on("message", on_message)
        script.load()
        try:
            result = script.exports_sync.apply()
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
        if messages:
            result["messages"] = messages
        return result
    finally:
        try:
            session.detach()
        except Exception:
            pass
