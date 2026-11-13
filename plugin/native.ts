// Roda no processo principal do Discord (fora das restrições de segurança da página).
import { execFile } from "child_process";
import type { IpcMainInvokeEvent } from "electron";
import { readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { delimiter, join } from "path";

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


// ---------- atualização do próprio plugin ----------
// Baixa index.tsx e native.ts do repositório do mestre, grava na pasta do Vencord e recompila.

const ARQUIVOS = ["index.tsx", "native.ts"];
const dirRepo = () => join(homedir(), "Vencord-RPG");
const dirPlugin = () => join(dirRepo(), "src", "userplugins", "rpgFundos");
const normalizar = (t: string) => t.replace(/\r\n/g, "\n").trim();

type Args = { repo: string; branch: string; };

function validar({ repo, branch }: Args) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[\w./-]+$/.test(branch))
        throw new Error("Repositório inválido");
}

async function baixarPlugin({ repo, branch }: Args, nome: string) {
    const r = await fetch(`https://${HOST_PERMITIDO}/${repo}/${branch}/plugin/${nome}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} ao baixar ${nome}`);
    return (await r.text()).replace(/SEU_USUARIO\/rpg-fundos/g, repo);
}

export async function verificarAtualizacao(_: IpcMainInvokeEvent, args: Args) {
    validar(args);
    for (const nome of ARQUIVOS) {
        let local: string;
        try { local = await readFile(join(dirPlugin(), nome), "utf8"); }
        catch { return { disponivel: false, motivo: "instalação não encontrada" }; }
        const remoto = await baixarPlugin(args, nome);
        if (normalizar(remoto) !== normalizar(local)) return { disponivel: true };
    }
    return { disponivel: false };
}

function executar(args: string[], cwd: string) {
    const env = {
        ...process.env,
        PATH: [process.env.PATH, join(process.env.APPDATA ?? "", "npm"), join(process.env.ProgramFiles ?? "", "nodejs")]
            .filter(Boolean).join(delimiter)
    };
    const win = process.platform === "win32";
    return new Promise<string>((res, rej) => {
        execFile(win ? "cmd.exe" : "pnpm", win ? ["/c", "pnpm", ...args] : args,
            { cwd, env, timeout: 5 * 60 * 1000, windowsHide: true },
            (err, stdout, stderr) => err
                ? rej(new Error((stderr || stdout || err.message).slice(-600)))
                : res(stdout.slice(-300)));
    });
}

export async function atualizar(_: IpcMainInvokeEvent, args: Args) {
    validar(args);
    const novos: Record<string, string> = {};
    for (const nome of ARQUIVOS) novos[nome] = await baixarPlugin(args, nome);

    const antigos: Record<string, string> = {};
    for (const nome of ARQUIVOS) antigos[nome] = await readFile(join(dirPlugin(), nome), "utf8");

    for (const nome of ARQUIVOS) await writeFile(join(dirPlugin(), nome), novos[nome], "utf8");
    try {
        return await executar(["build"], dirRepo());
    } catch (e) {
        // build falhou: volta os arquivos antigos para não deixar a instalação pela metade
        for (const nome of ARQUIVOS) await writeFile(join(dirPlugin(), nome), antigos[nome], "utf8");
        throw e;
    }
}
