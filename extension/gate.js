// 渡した tab の MAIN world だけに入れる WebAuthn の見張り（図 §47）。操作権を持っている間だけ。呼ばれたら本物の dialog（Chrome が前面に出す）は出さず断り、印を DOM に残す（isolated の page() が読む）。off で元の関数に戻す
export function gateHook(on) {
  const C = navigator.credentials, G = (globalThis.__kangaeGate ??= { orig: null });
  if (!C) return "none";
  if (on && !G.orig) {
    G.orig = { get: C.get, create: C.create };
    const stop = () => { document.documentElement.setAttribute("data-kangae-gate", "webauthn"); return Promise.reject(new DOMException("人にしかできない確認です", "NotAllowedError")); };
    C.get = function (o) { return o && o.publicKey ? stop() : G.orig.get.call(this, o); };
    C.create = function (o) { return o && o.publicKey ? stop() : G.orig.create.call(this, o); };
  } else if (!on && G.orig) {
    C.get = G.orig.get; C.create = G.orig.create; G.orig = null;
    document.documentElement.removeAttribute("data-kangae-gate");
  }
  return G.orig ? "on" : "off";
}
