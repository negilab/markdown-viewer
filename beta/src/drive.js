/* ============================================================================
 *  Google ドライブの原本を開いて、そのまま上書き保存する
 *  - ログイン: Google Identity Services（アクセストークン方式）
 *  - ファイル選び: Google Picker
 *  - 読み書き: Drive API v3
 *  権限は drive.file（このページで選んだファイルだけ触れる）。ドライブ全体は見ない。
 * ==========================================================================*/

/* Google Cloud Console で作った値。どれもページの中で使う公開用の値で、秘密ではない
   （APIキーは negilab.github.io からしか使えないよう、Console 側で制限しておく） */
export const GOOGLE = {
  clientId: "735606358037-k1u1cesfr0u1hmummenlj1tbr35it7tr.apps.googleusercontent.com",   /* OAuth クライアント ID（…apps.googleusercontent.com） */
  apiKey: "AIzaSyAUdDVF1N04ESyrJH7IlWm5oYR51JD7kN8",     /* API キー（Picker 用） */
  appId: "735606358037",      /* プロジェクト番号（数字だけ） */
};

const SCOPE = "https://www.googleapis.com/auth/drive.file";
export const configured = () => !!(GOOGLE.clientId && GOOGLE.apiKey && GOOGLE.appId);

let tokenClient = null, token = null, tokenExp = 0, pending = null, pickerReady = false;

const loadScript = src => new Promise((res, rej) => {
  if (document.querySelector('script[src="' + src + '"]')) return res();
  const s = document.createElement("script");
  s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error("load " + src));
  document.head.appendChild(s);
});

/* ログインのポップアップは「押した瞬間」に開かないとブロックされるので、部品は前もって読んでおく */
export async function preload() {
  if (!configured()) return;
  await Promise.all([loadScript("https://accounts.google.com/gsi/client"), loadScript("https://apis.google.com/js/api.js")]);
  await new Promise(res => window.gapi.load("picker", { callback: res }));
  pickerReady = true;
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE.clientId,
    scope: SCOPE,
    callback: r => {
      const p = pending; pending = null;
      if (!p) return;
      if (r.error) return p.rej(new Error(r.error));
      token = r.access_token;
      tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000;
      p.res(token);
    },
    error_callback: e => { const p = pending; pending = null; if (p) p.rej(Object.assign(new Error(e.type || "popup"), { name: "AbortError" })); },
  });
}
export const ready = () => !!tokenClient && pickerReady;

/* 押した処理の中で、await より前に呼ぶこと（ポップアップのため） */
export function getToken() {
  if (token && Date.now() < tokenExp) return Promise.resolve(token);
  if (!tokenClient) return Promise.reject(new Error("not ready"));
  return new Promise((res, rej) => {
    pending = { res, rej };
    tokenClient.requestAccessToken();
  });
}

async function api(url, opts = {}) {
  const t = await getToken();
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + t } });
  if (r.status === 401) { token = null; throw new Error("expired"); }
  if (!r.ok) throw new Error("drive " + r.status);
  return r;
}

const FIELDS = "id,name,mimeType,modifiedTime";

/* ドライブからファイルを選んで、中身と情報を返す。取り消したら null */
export async function open(tokenPromise) {
  const t = await tokenPromise;
  const picked = await new Promise(res => {
    const G = window.google.picker;
    const view = new G.DocsView(G.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false).setMode(G.DocsViewMode.LIST);
    new G.PickerBuilder()
      .addView(view)
      .setOAuthToken(t)
      .setDeveloperKey(GOOGLE.apiKey)
      .setAppId(GOOGLE.appId)
      .setLocale("ja")
      .setTitle("開く Markdown ファイルを選んでください")
      .setCallback(d => {
        if (d.action === G.Action.PICKED) res(d.docs[0]);
        else if (d.action === G.Action.CANCEL) res(null);
      })
      .build().setVisible(true);
  });
  if (!picked) return null;
  const meta = await (await api("https://www.googleapis.com/drive/v3/files/" + picked.id + "?fields=" + FIELDS)).json();
  const text = await (await api("https://www.googleapis.com/drive/v3/files/" + picked.id + "?alt=media")).text();
  return { meta, text };
}

/* 原本に上書きする。開いたあとにドライブ側で変わっていたら、confirmChanged() で確かめる */
export async function save(tokenPromise, meta, text, confirmChanged) {
  await tokenPromise;
  const now = await (await api("https://www.googleapis.com/drive/v3/files/" + meta.id + "?fields=" + FIELDS)).json();
  if (meta.modifiedTime && now.modifiedTime !== meta.modifiedTime && !confirmChanged()) {
    throw Object.assign(new Error("changed"), { name: "AbortError" });
  }
  const r = await api("https://www.googleapis.com/upload/drive/v3/files/" + meta.id + "?uploadType=media&fields=" + FIELDS, {
    method: "PATCH",
    headers: { "Content-Type": meta.mimeType && /^text\//.test(meta.mimeType) ? meta.mimeType + "; charset=UTF-8" : "text/markdown; charset=UTF-8" },
    body: text,
  });
  return r.json();
}
