// Shared webview state and helpers — imported by all webview modules.

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

export interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export const vscode: VsCodeApi = acquireVsCodeApi();

export let currentRequest: any = null;
export let updateDocumentTimer: ReturnType<typeof setTimeout> | null = null;
export let ignoreNextLoad = false;
export let currentBodyType = 'none';
export let currentLang = 'json';

export function setCurrentRequest(req: any): void { currentRequest = req; }
export function setUpdateDocumentTimer(timer: ReturnType<typeof setTimeout> | null): void { updateDocumentTimer = timer; }
export function setIgnoreNextLoad(val: boolean): void { ignoreNextLoad = val; }
export function setCurrentBodyType(type: string): void { currentBodyType = type; }
export function setCurrentLang(lang: string): void { currentLang = lang; }

export function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

export function $input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

export function esc(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
