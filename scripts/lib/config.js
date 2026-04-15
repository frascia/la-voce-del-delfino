import { caricaJSON } from "./utils.js";

let CONFIG = null;
let CONFIG_PATH = null;

export function initConfig(path) {
    CONFIG_PATH = path;
}

export function loadConfig() {
    if (!CONFIG && CONFIG_PATH) {
        CONFIG = caricaJSON(CONFIG_PATH, {});
    }
    return CONFIG;
}

export function getVociAttive(oggi) {
    const { REDAZIONE } = loadConfig();
    return REDAZIONE.filter(voce => {
        if (voce.g === "default") return true;
        return voce.g.split(",").map(g => g.trim()).includes(oggi);
    });
}