/* ============================================================================
 *  Google ドライブの原本を開いて、そのまま上書き保存する
 *  - ログイン: Google Identity Services（アクセストークン方式）
 *  - ファイル選び: Google Picker
 *  - 読み書き: Drive API v3
 *  権限はドライブ全体（drive）。PC のパスからファイルを探して上書きするため。
 *  （Google ドライブのパソコン用アプリで同期した C ドライブのフォルダは、ドライブの「パソコン」に入る）
 * ==========================================================================*/

/* Google Cloud Console で作った値。どれもページの中で使う公開用の値で、秘密ではない
   （APIキーは negilab.github.io からしか使えないよう、Console 側で制限しておく） */
export const GOOGLE = {
  clientId: "735606358037-k1u1cesfr0u1hmummenlj1tbr35it7tr.apps.googleusercontent.com",   /* OAuth クライアント ID（…apps.googleusercontent.com） */
  apiKey: "AIzaSyAUdDVF1N04ESyrJH7IlWm5oYR51JD7kN8",     /* API キー（Picker 用） */
  appId: "735606358037",      /* プロジェクト番号（数字だけ） */
};

const SCOPE = "https://www.googleapis.com/auth/drive";
export const configured = () => !!(GOOGLE.clientId && GOOGLE.apiKey && GOOGLE.appId);

let tokenClient = null, token = null, tokenExp = 0, pending = null, pickerReady = false;

/* リンクから開くたびにログインを押さなくて済むよう、有効期限（約1時間）までこの端末に覚えておく */
const TOKEN_KEY = "mdb.gtoken";
try {
  const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
  if (t && t.scope === SCOPE && t.exp > Date.now()) { token = t.token; tokenExp = t.exp; }
} catch (e) {}
const keepToken = () => { try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, exp: tokenExp, scope: SCOPE })); } catch (e) {} };
export const hasToken = () => !!token && Date.now() < tokenExp;
let preloading = null;

const loadScript = src => new Promise((res, rej) => {
  if (document.querySelector('script[src="' + src + '"]')) return res();
  const s = document.createElement("script");
  s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error("load " + src));
  document.head.appendChild(s);
});

/* ログインのポップアップは「押した瞬間」に開かないとブロックされるので、部品は前もって読んでおく */
export function preload() {
  if (!configured()) return Promise.resolve();
  return preloading || (preloading = load());
}
async function load() {
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
      keepToken();
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
  if (r.status === 401) { token = null; tokenExp = 0; try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} throw new Error("expired"); }
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
  const now = await (await api("https://www.googleapis.com/drive/v3/files/" + meta.id + "?fields=" + FIELDS + "&supportsAllDrives=true")).json();
  if (meta.modifiedTime && now.modifiedTime !== meta.modifiedTime && !confirmChanged()) {
    throw Object.assign(new Error("changed"), { name: "AbortError" });
  }
  const r = await api("https://www.googleapis.com/upload/drive/v3/files/" + meta.id + "?uploadType=media&supportsAllDrives=true&fields=" + FIELDS, {
    method: "PATCH",
    headers: { "Content-Type": meta.mimeType && /^text\//.test(meta.mimeType) ? meta.mimeType + "; charset=UTF-8" : "text/markdown; charset=UTF-8" },
    body: text,
  });
  return r.json();
}

/* ============================================================================
 *  PC のパスから、ドライブの中の同じファイルを探す
 *    G:\マイドライブ\a\b.md  → マイドライブの a/b.md
 *    C:\Users\81809\claude\b.md → 同期した「claude」フォルダ（ドライブの「パソコン」）の b.md
 *  ファイル名で探し、見つかった候補の親フォルダをさかのぼって、パスの後ろから何段一致するかで選ぶ。
 * ==========================================================================*/
const DRIVE_Q = "&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives";
const qstr = v => "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
const ROOT_NAMES = /^(マイドライブ|マイ ドライブ|My Drive)$/i;

export function splitPath(p) {
  return String(p).trim().replace(/^["']|["']$/g, "").replace(/\//g, "\\").split("\\").filter(Boolean);
}

export async function findByPath(tokenPromise, localPath) {
  await tokenPromise;
  const segs = splitPath(localPath);
  const name = segs[segs.length - 1];
  if (!name) return { found: [], name: "" };
  const q = encodeURIComponent("name = " + qstr(name) + " and trashed = false and mimeType != 'application/vnd.google-apps.folder'");
  const list = await (await api("https://www.googleapis.com/drive/v3/files?q=" + q +
    "&pageSize=50&fields=files(" + FIELDS + ",parents)" + DRIVE_Q)).json();
  const folders = new Map();
  const folder = async id => {
    if (!folders.has(id)) folders.set(id, api("https://www.googleapis.com/drive/v3/files/" + id +
      "?fields=id,name,parents&supportsAllDrives=true").then(r => r.json()).catch(() => null));
    return folders.get(id);
  };
  /* 候補ごとに、パスの後ろ（ファイルの親から上）と何段一致するか数える */
  const want = segs.slice(0, -1).reverse().map(s => s.toLowerCase());
  const scored = await Promise.all((list.files || []).map(async f => {
    let score = 0, id = f.parents && f.parents[0], names = [];
    for (let d = 0; id && d < 30; d++) {
      const fo = await folder(id);
      if (!fo) break;
      names.push(fo.name);
      const w = want[d];
      if (w === undefined) break;
      const same = fo.name.toLowerCase() === w || (ROOT_NAMES.test(fo.name) && ROOT_NAMES.test(w));
      if (!same) break;
      score++;
      id = fo.parents && fo.parents[0];
    }
    return { meta: { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }, score, where: names.reverse().join(" / ") };
  }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored.length ? scored[0].score : 0;
  return { name, found: scored.filter(x => x.score === best), others: scored.length };
}

export async function read(tokenPromise, meta) {
  await tokenPromise;
  return (await api("https://www.googleapis.com/drive/v3/files/" + meta.id + "?alt=media&supportsAllDrives=true")).text();
}
