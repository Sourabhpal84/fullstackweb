(() => {
  const TYPES = new Set(["success", "error", "warning", "info"]);

  function ensureStyles(){
    if(document.getElementById("mzNotifyStyles")) return;
    const style = document.createElement("style");
    style.id = "mzNotifyStyles";
    style.textContent = `
      .mz-toast-host{position:fixed;right:16px;top:16px;z-index:1000000;display:grid;gap:10px;width:min(380px,calc(100vw - 32px));pointer-events:none}
      .mz-toast{pointer-events:auto;display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:start;padding:14px 14px;border-radius:16px;color:#f8fafc;background:linear-gradient(145deg,#101827,#182235);border:1px solid rgba(255,255,255,.12);box-shadow:0 20px 70px rgba(0,0,0,.34);animation:mzToastIn .24s cubic-bezier(.2,.8,.2,1) both;font:700 13px Poppins,system-ui,sans-serif}
      .mz-toast.hide{animation:mzToastOut .2s ease both}.mz-toast b{display:block;margin-bottom:2px;font-size:13px}.mz-toast span{color:#cbd5e1;font-weight:600;line-height:1.45}.mz-toast i{width:12px;height:12px;border-radius:50%;margin-top:4px;background:#38bdf8;box-shadow:0 0 18px currentColor}.mz-toast.success i{background:#22c55e;color:#22c55e}.mz-toast.error i{background:#ef4444;color:#ef4444}.mz-toast.warning i{background:#f59e0b;color:#f59e0b}.mz-toast.info i{background:#38bdf8;color:#38bdf8}.mz-toast button{border:0;background:rgba(255,255,255,.08);color:#fff;border-radius:10px;width:30px;height:30px;cursor:pointer;font-weight:900}
      .mz-confirm-backdrop{position:fixed;inset:0;z-index:1000001;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(2,6,23,.68);backdrop-filter:blur(12px)}
      .mz-confirm{width:min(420px,100%);border-radius:22px;background:linear-gradient(145deg,#101827,#182235);border:1px solid rgba(255,255,255,.12);box-shadow:0 30px 100px rgba(0,0,0,.55);padding:20px;color:#f8fafc;font-family:Poppins,system-ui,sans-serif;animation:mzToastIn .22s ease both}
      .mz-confirm h3{margin:0 0 8px;font-size:18px}.mz-confirm p{margin:0;color:#cbd5e1;line-height:1.55;font-size:13px}.mz-confirm-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}.mz-confirm-actions button{border:0;border-radius:13px;min-height:42px;padding:0 14px;font-weight:900;cursor:pointer}.mz-cancel{background:rgba(255,255,255,.08);color:#fff}.mz-ok{background:linear-gradient(135deg,#ff7b00,#22c55e);color:#06110a}
      @keyframes mzToastIn{from{opacity:0;transform:translate3d(18px,-10px,0) scale(.98)}to{opacity:1;transform:none}}@keyframes mzToastOut{to{opacity:0;transform:translate3d(18px,-10px,0) scale(.98)}}
      @media(max-width:640px){.mz-toast-host{right:10px;left:10px;top:auto;bottom:12px;width:auto}.mz-toast{border-radius:14px}.mz-confirm{border-radius:18px}}
    `;
    document.head.appendChild(style);
  }

  function host(){
    ensureStyles();
    let node = document.getElementById("mzToastHost");
    if(!node){
      node = document.createElement("div");
      node.id = "mzToastHost";
      node.className = "mz-toast-host";
      node.setAttribute("aria-live", "polite");
      document.body.appendChild(node);
    }
    return node;
  }

  function titleFor(type){
    return ({ success:"Success", error:"Error", warning:"Warning", info:"Info" })[type] || "Info";
  }

  function notify(message, type = "info", options = {}){
    const cleanType = TYPES.has(type) ? type : "info";
    const node = document.createElement("div");
    node.className = `mz-toast ${cleanType}`;
    node.innerHTML = `<i></i><div><b>${options.title || titleFor(cleanType)}</b><span></span></div><button type="button" aria-label="Close">x</button>`;
    node.querySelector("span").textContent = String(message || "");
    host().appendChild(node);
    const close = () => {
      node.classList.add("hide");
      setTimeout(() => node.remove(), 220);
    };
    node.querySelector("button").addEventListener("click", close);
    setTimeout(close, options.duration || 3600);
    return node;
  }

  function confirmDialog(message, options = {}){
    ensureStyles();
    return new Promise(resolve => {
      const backdrop = document.createElement("div");
      backdrop.className = "mz-confirm-backdrop";
      backdrop.innerHTML = `
        <div class="mz-confirm" role="dialog" aria-modal="true">
          <h3>${options.title || "Please confirm"}</h3>
          <p></p>
          <div class="mz-confirm-actions">
            <button type="button" class="mz-cancel">${options.cancelText || "Cancel"}</button>
            <button type="button" class="mz-ok">${options.okText || "Confirm"}</button>
          </div>
        </div>`;
      backdrop.querySelector("p").textContent = String(message || "");
      document.body.appendChild(backdrop);
      const done = value => {
        backdrop.remove();
        resolve(value);
      };
      backdrop.querySelector(".mz-cancel").addEventListener("click", () => done(false));
      backdrop.querySelector(".mz-ok").addEventListener("click", () => done(true));
      backdrop.addEventListener("click", event => {
        if(event.target === backdrop) done(false);
      });
      backdrop.querySelector(".mz-ok").focus();
    });
  }

  window.MagneetozNotify = {
    success: (message, options) => notify(message, "success", options),
    error: (message, options) => notify(message, "error", options),
    warning: (message, options) => notify(message, "warning", options),
    info: (message, options) => notify(message, "info", options),
    toast: notify,
    confirm: confirmDialog
  };

  window.alert = message => notify(message, String(message || "").toLowerCase().includes("error") || String(message || "").toLowerCase().includes("failed") ? "error" : "info");
})();
