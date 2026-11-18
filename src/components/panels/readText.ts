import { invoke } from "@tauri-apps/api/core";

/** Read a decklist the user picked in the file dialog. */
export const readTextFile = (path: string) => invoke<string>("read_text_file", { path });
