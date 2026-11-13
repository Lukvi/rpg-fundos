// Roda no processo principal do Discord (fora das restrições de segurança da página).
import type { IpcMainInvokeEvent } from "electron";

const MAX_BYTES = 12 * 1024 * 1024;
const HOST_PERMITIDO = "raw.githubusercontent.com";

function checar(url: string) {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== HOST_PERMITIDO)
        throw new Error("Endereço não permitido");
}

export async function buscarTexto(_: IpcMainInvokeEvent, url: string) {
    checar(url);
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
}

export async function buscarImagem(_: IpcMainInvokeEvent, url: string) {
    checar(url);
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error("Imagem grande demais");
    const tipo = r.headers.get("content-type") ?? "image/jpeg";
    return `data:${tipo};base64,${buf.toString("base64")}`;
}

type Arquivo = { caminho: string; base64?: string; texto?: string; };

export async function publicar(
    _: IpcMainInvokeEvent,
    args: { token: string; repo: string; branch: string; arquivos: Arquivo[]; }
) {
    const { token, repo, branch, arquivos } = args;
    if (!token) throw new Error("Falta o token do GitHub nas configurações do plugin");

    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "RPGFundos",
        "Content-Type": "application/json"
    };

    for (const a of arquivos) {
        const api = `https://api.github.com/repos/${repo}/contents/${a.caminho}`;
        let sha: string | undefined;

        const atual = await fetch(`${api}?ref=${encodeURIComponent(branch)}`, { headers });
        if (atual.ok) sha = (await atual.json()).sha;
        else if (atual.status !== 404) throw new Error(`GitHub respondeu ${atual.status} (verifique token e repositório)`);

        const content = a.base64 ?? Buffer.from(a.texto ?? "", "utf8").toString("base64");
        const r = await fetch(api, {
            method: "PUT",
            headers,
            body: JSON.stringify({ message: `RPGFundos: ${a.caminho}`, content, branch, sha })
        });
        if (!r.ok) throw new Error(`Falha ao enviar ${a.caminho}: ${r.status}`);
    }
    return true;
}
