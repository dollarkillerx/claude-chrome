import { BridgeError, isMethod, type Method, type RequestMessage, type ResponseMessage } from "@claude-chrome/protocol";
import { mapChromeError } from "./cdp";
import { find, readPage } from "./handlers/accessibility";
import { click, hover, key, scroll, type } from "./handlers/input";
import { consoleLogs, evalJs, getPageText } from "./handlers/page";
import { screenshot } from "./handlers/screenshot";
import { navigate, status, tabsClose, tabsCreate, tabsList, tabsSelect } from "./handlers/tabs";
import { fileUpload } from "./handlers/upload";
import { getSettings } from "./settings";

export type Params = Record<string, any>;

/** Per-call context: which Claude session issued the request. */
export interface Context {
  session: string;
}

type Handler = (params: Params, ctx: Context) => Promise<unknown>;

const HANDLERS: Record<Method, Handler> = {
  status,
  tabs_list: tabsList,
  tabs_create: tabsCreate,
  tabs_select: tabsSelect,
  tabs_close: tabsClose,
  navigate,
  screenshot,
  read_page: readPage,
  find,
  click,
  hover,
  type,
  key,
  scroll,
  get_page_text: getPageText,
  eval_js: evalJs,
  console_logs: consoleLogs,
  file_upload: fileUpload,
};

export async function dispatch(request: RequestMessage): Promise<ResponseMessage> {
  try {
    if (!isMethod(request.method)) throw new BridgeError("BAD_REQUEST", `Unknown method ${String(request.method)}`);
    if ((await getSettings()).paused) throw new BridgeError("PAUSED", "The user paused Claude in the extension popup.");
    if (typeof request.session !== "string" || !request.session) {
      throw new BridgeError("BAD_REQUEST", "Missing session id (server and extension versions differ?)");
    }
    const result = await HANDLERS[request.method](request.params ?? {}, { session: request.session });
    return { type: "response", id: request.id, result };
  } catch (error) {
    return { type: "response", id: request.id, error: mapChromeError(error).toJSON() };
  }
}
