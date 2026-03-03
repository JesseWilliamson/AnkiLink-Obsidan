import { Editor, Modal, Notice, Plugin, TFile, setIcon } from "obsidian";
import { DEFAULT_SETTINGS, AnkiLinkSettings, AnkiLinkSettingsTab } from "./settings";
import { syncVaultNotes } from "./syncUtil";
import { FC_PREAMBLE_P } from "./regexUtil";

const ANKI_LINK_ICON = "circle-question-mark";

export default class AnkiLink extends Plugin {
    settings!: AnkiLinkSettings;
    private statusBarItemEl!: HTMLElement;
    private statusBarRefreshToken = 0;

    async onload() {
        await this.loadSettings();

        this.addRibbonIcon(ANKI_LINK_ICON, "Sample", async (_evt: MouseEvent) => {
            await this.runSyncAndNotify();
        });

        this.addCommand({
            id: "sync-cards",
            name: "Sync cards",
            callback: async () => {
                await this.runSyncAndNotify();
            },
        });

        this.addCommand({
            id: "add-flashcard",
            name: "Add flashcard",
            editorCallback: (editor: Editor) => {
                this.insertFlashcard(editor);
            },
        });

        this.statusBarItemEl = this.addStatusBarItem();
        this.statusBarItemEl.addClass("anki-link-status");
        this.statusBarItemEl.addClass("mod-clickable");
        this.registerDomEvent(this.statusBarItemEl, "click", () => {
            void this.showMissingDeckNotesModal();
        });
        void this.refreshStatusBar();

        this.registerEvent(
            this.app.workspace.on("file-open", () => {
                void this.refreshStatusBar();
            }),
        );
        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile?.path !== file.path) return;
                void this.refreshStatusBar();
            }),
        );
        this.registerEvent(
            this.app.metadataCache.on("changed", (file) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile?.path !== file.path) return;
                void this.refreshStatusBar();
            }),
        );

        this.addSettingTab(new AnkiLinkSettingsTab(this.app, this));
    }

    async loadSettings() {
        this.settings = {
            ...DEFAULT_SETTINGS,
            ...((await this.loadData()) as Partial<AnkiLinkSettings>),
        };
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private insertFlashcard(editor: Editor) {
        const template = "> [!flashcard] ";
        editor.replaceSelection(template);
    }

    private async runSyncAndNotify(): Promise<void> {
        const syncingNotice = new Notice("Syncing flashcards", 0);
        const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        let spinnerFrameIndex = 0;
        const spinnerIntervalId = globalThis.setInterval(() => {
            const spinner = spinnerFrames[spinnerFrameIndex % spinnerFrames.length]!;
            syncingNotice.setMessage(`${spinner} Syncing flashcards`);
            spinnerFrameIndex += 1;
        }, 90);
        try {
            const { added, modified, deleted } = await syncVaultNotes(this.app);
            globalThis.clearInterval(spinnerIntervalId);
            syncingNotice.setMessage(
                `Synced flashcards.\nAdded ${added} card${added === 1 ? "" : "s"},\nmodified ${modified} card${modified === 1 ? "" : "s"},\ndeleted ${deleted} card${deleted === 1 ? "" : "s"}.`,
            );
        } catch (error) {
            globalThis.clearInterval(spinnerIntervalId);
            syncingNotice.hide();
            console.error(error);
            new Notice(`Failed to sync flashcards: ${this.getErrorMessage(error)}`);
        }
    }

    private getErrorMessage(error: unknown): string {
        if (error instanceof Error && error.message) {
            return error.message;
        }

        if (typeof error === "string" && error.trim().length > 0) {
            return error;
        }

        return "Unknown error";
    }

    private async refreshStatusBar(): Promise<void> {
        const refreshToken = ++this.statusBarRefreshToken;
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile?.extension !== "md") {
            this.setStatusBarState("Anki: -");
            return;
        }

        const hasFlashcards = await this.fileHasFlashcards(activeFile);
        if (refreshToken !== this.statusBarRefreshToken) return;

        const configuredDeck = this.getConfiguredDeck(activeFile);
        if (!hasFlashcards) {
            this.setStatusBarState("Anki: no cards");
            return;
        }
        if (!configuredDeck) {
            this.setStatusBarState("Anki: ⚠ deck missing", true);
            return;
        }
        this.setStatusBarState(`Anki: ${configuredDeck}`);
    }

    private async fileHasFlashcards(file: TFile): Promise<boolean> {
        const content = await this.app.vault.read(file);
        return content.split("\n").some((line) => FC_PREAMBLE_P.test(line));
    }

    private async showMissingDeckNotesModal(): Promise<void> {
        const loadingNotice = new Notice("Checking notes for missing Anki deck...", 0);
        try {
            const missingDeckFiles = await this.findNotesMissingDeckNames();
            new MissingDeckNotesModal(this, missingDeckFiles).open();
        } finally {
            loadingNotice.hide();
        }
    }

    private async findNotesMissingDeckNames(): Promise<TFile[]> {
        const markdownFiles = this.app.vault.getMarkdownFiles();
        const missingDeckFiles: TFile[] = [];
        for (const file of markdownFiles) {
            if (this.getConfiguredDeck(file)) continue;
            if (await this.fileHasFlashcards(file)) {
                missingDeckFiles.push(file);
            }
        }
        return missingDeckFiles;
    }

    private getConfiguredDeck(file: TFile): string | undefined {
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!frontmatter) return undefined;
        for (const [key, value] of Object.entries(frontmatter)) {
            if (key.toLowerCase() !== "anki deck") continue;
            if (typeof value !== "string") continue;
            const trimmed = value.trim();
            if (trimmed.length > 0) {
                return trimmed;
            }
        }
        return undefined;
    }

    private setStatusBarState(text: string, isWarning = false): void {
        this.statusBarItemEl.empty();
        this.statusBarItemEl.setAttribute("aria-label", text);
        this.statusBarItemEl.setAttribute("title", text);
        setIcon(this.statusBarItemEl, ANKI_LINK_ICON);
        this.statusBarItemEl.style.color = isWarning ? "var(--text-error)" : "";
    }
}

class MissingDeckNotesModal extends Modal {
    constructor(
        private readonly plugin: AnkiLink,
        private readonly files: TFile[],
    ) {
        super(plugin.app);
    }

    override onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h3", { text: "Notes missing Anki deck" });

        if (this.files.length === 0) {
            contentEl.createEl("p", { text: "No notes with flashcards are missing an Anki deck." });
            return;
        }

        contentEl.createEl("p", {
            text: `${this.files.length} note${this.files.length === 1 ? "" : "s"} found.`,
        });
        const listEl = contentEl.createEl("ul", { cls: "anki-link-missing-deck-list" });
        for (const file of this.files) {
            const itemEl = listEl.createEl("li");
            const linkEl = itemEl.createEl("a", { text: file.path });
            linkEl.href = "#";
            linkEl.addEventListener("click", (event) => {
                event.preventDefault();
                void this.openFile(file);
            });
        }
    }

    override onClose(): void {
        this.contentEl.empty();
    }

    private async openFile(file: TFile): Promise<void> {
        await this.plugin.app.workspace.getLeaf(true).openFile(file);
        this.close();
    }
}
