import frida

JS = r"""
const MODULE = "SB-Win64-Shipping.exe";
const PATTERN = "4D 8B 37 41 8B D4 E8 ?? ?? ?? ?? ?? 8B ?? ?? ?? 8D ?? 01";

function rel32(from, to) {
    return to.sub(from).toInt32();
}

rpc.exports = {
    apply: function () {
        const mod = Process.findModuleByName(MODULE);
        if (mod === null) {
            return { ok: false, error: "module-not-found" };
        }
        const found = Memory.scanSync(mod.base, mod.size, PATTERN);
        if (found.length === 0) {
            return { ok: false, error: "pattern-not-found" };
        }
        const addr = found[0].address;
        const original = new Uint8Array(addr.readByteArray(6));
        // Prefer an existing executable code cave in the same module. This
        // keeps the relative jump within rel32 range without guessing an
        // allocation address.
        const caves = Memory.scanSync(mod.base, mod.size,
            "CC CC CC CC CC CC CC CC CC CC CC CC CC CC CC CC");
        let cave = null;
        let best = null;
        for (const c of caves) {
            const delta = c.address.sub(addr.add(5)).toInt32();
            const dist = Math.abs(delta);
            if (best === null || dist < best) {
                best = dist;
                cave = c.address;
            }
        }
        if (cave === null) {
            return { ok: false, error: "no-code-cave" };
        }
        Memory.protect(cave, 64, "rwx");
        Memory.protect(addr, 6, "rwx");

        const targetNext = addr.add(6);
        const caveJumpNext = cave.add(10);
        const caveBytes = new Uint8Array(10);
        caveBytes[0] = 0x4D; // mov r14, [r15]
        caveBytes[1] = 0x8B;
        caveBytes[2] = 0x37;
        caveBytes[3] = 0x31; // xor edx, edx
        caveBytes[4] = 0xD2;
        caveBytes[5] = 0xE9; // jmp targetNext
        const relCave = rel32(caveJumpNext, targetNext);
        caveBytes[6] = relCave & 0xFF;
        caveBytes[7] = (relCave >> 8) & 0xFF;
        caveBytes[8] = (relCave >> 16) & 0xFF;
        caveBytes[9] = (relCave >> 24) & 0xFF;
        cave.writeByteArray(caveBytes);

        const patch = new Uint8Array(6);
        patch[0] = 0xE9;
        const relPatch = rel32(addr.add(5), cave);
        patch[1] = relPatch & 0xFF;
        patch[2] = (relPatch >> 8) & 0xFF;
        patch[3] = (relPatch >> 16) & 0xFF;
        patch[4] = (relPatch >> 24) & 0xFF;
        patch[5] = 0x90;
        addr.writeByteArray(patch);
        Memory.protect(addr, 6, "r-x");

        return {
            ok: true,
            address: addr.toString(),
            original: Array.from(original),
            cave: cave.toString()
        };
    }
};
"""


def apply_drop_rate_patch():
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
