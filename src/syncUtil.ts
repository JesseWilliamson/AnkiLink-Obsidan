import { App, TFile } from "obsidian";
import { remark } from "remark";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkHtml from "remark-html";
import {
    AnkiMultiAction,
    ANKI_LINK_MODEL_NAME,
    ANKI_LINK_TAG,
    Note,
    NoteFields,
    NoteInfo,
    buildNote,
    noteHasTag,
    sendCreateDeckRequest,
    sendCreateModelRequest,
    sendDeckNamesRequest,
    sendMultiRequest,
    sendModelNamesRequest,
    sendUpdateModelStylingRequest,
    sendUpdateModelTemplatesRequest,
} from "./ankiConnectUtil";
import { FC_PREAMBLE_P } from "./regexUtil";

const LOG_PREFIX = "[anki-link]";

function logSync(message: string, ...args: unknown[]): void {
    console.debug(`${LOG_PREFIX} ${message}`, ...args);
}

interface ParsedNoteData {
    id: number | undefined;
    index: number;
    note: Note;
}

export interface SyncSummary {
    added: number;
    modified: number;
    deleted: number;
}

interface FileSyncContext {
    file: TFile;
    filePath: string;
    deckName: string;
    lines: string[];
    notesData: ParsedNoteData[];
    linesModified: boolean;
}

interface PendingNoteCreation {
    context: FileSyncContext;
    noteData: ParsedNoteData;
}

interface GlobalReadState {
    taggedNoteIdsAtStart: Set<number>;
    existingNotesById: Map<number, NoteInfo>;
    notesInDeckByName: Map<string, Set<number>>;
}

export async function syncVaultNotes(app: App): Promise<SyncSummary> {
    const markdownFiles = app.vault.getMarkdownFiles();
    logSync(`Sync started. Found ${markdownFiles.length} markdown files.`);
    const fileDecks = new Map<string, string>();
    const decksInUse = new Set<string>();
    for (const file of markdownFiles) {
        const deckName = await getDeckNameForFile(app, file);
        if (!deckName) continue;
        fileDecks.set(file.path, deckName);
        decksInUse.add(deckName);
    }
    logSync(`Preparing sync for ${fileDecks.size} files across ${decksInUse.size} decks.`);

    await ensureDecksExist(decksInUse);
    await ensureModelIsConfigured();
    const syncContexts = await loadSyncContexts(app, markdownFiles, fileDecks);
    const globalReadState = await loadGlobalReadState(syncContexts, decksInUse);
    logSync(
        `Loaded ${globalReadState.taggedNoteIdsAtStart.size} tagged notes from Anki before sync.`,
    );

    let totalModified = 0;
    const seenNoteIds = new Set<number>();
    const noteMutationActions: AnkiMultiAction[] = [];
    const noteIdsToTag = new Set<number>();
    const notesToCreate: PendingNoteCreation[] = [];
    for (const context of syncContexts) {
        logSync(`Syncing file: ${context.filePath} (deck: ${context.deckName})`);
        logSync(`Parsed ${context.notesData.length} notes from ${context.filePath}.`);
        const notesInDeck =
            globalReadState.notesInDeckByName.get(context.deckName) ?? new Set<number>();
        for (const noteData of context.notesData) {
            if (noteData.id == undefined) {
                notesToCreate.push({ context, noteData });
                continue;
            }
            const ankiNote = globalReadState.existingNotesById.get(noteData.id);
            if (!ankiNote) {
                notesToCreate.push({ context, noteData });
                continue;
            }
            seenNoteIds.add(ankiNote.noteId);
            if (!noteHasTag(ankiNote, ANKI_LINK_TAG)) {
                noteIdsToTag.add(ankiNote.noteId);
                continue;
            }

            let noteWasModified = false;
            if (
                !notesInDeck.has(ankiNote.noteId) &&
                Array.isArray(ankiNote.cards) &&
                ankiNote.cards.length > 0
            ) {
                noteMutationActions.push({
                    action: "changeDeck",
                    params: { cards: ankiNote.cards, deck: context.deckName },
                });
                notesInDeck.add(ankiNote.noteId);
                noteWasModified = true;
            }
            if (noteFieldsDiffer(noteData.note.fields, ankiNote.fields)) {
                noteMutationActions.push({
                    action: "updateNoteFields",
                    params: { note: { id: ankiNote.noteId, fields: noteData.note.fields } },
                });
                noteWasModified = true;
            }
            if (noteWasModified) {
                totalModified += 1;
            }
        }
    }

    const orphanedNoteIds = [...globalReadState.taggedNoteIdsAtStart].filter(
        (noteId) => !seenNoteIds.has(noteId),
    );
    if (orphanedNoteIds.length > 0) {
        logSync(`Deleting ${orphanedNoteIds.length} orphaned notes from Anki.`);
    }
    const mutationActions: AnkiMultiAction[] = [];
    const addNotesActionIndex =
        notesToCreate.length > 0
            ? mutationActions.push({
                  action: "addNotes",
                  params: { notes: notesToCreate.map((entry) => entry.noteData.note) },
              }) - 1
            : -1;
    for (const action of noteMutationActions) {
        mutationActions.push(action);
    }
    if (noteIdsToTag.size > 0) {
        mutationActions.push({
            action: "addTags",
            params: { notes: [...noteIdsToTag], tags: ANKI_LINK_TAG },
        });
    }
    if (orphanedNoteIds.length > 0) {
        mutationActions.push({ action: "deleteNotes", params: { notes: orphanedNoteIds } });
    }

    let createdNoteIds: number[] = [];
    if (mutationActions.length > 0) {
        logSync(`Sending ${mutationActions.length} batched mutation actions.`);
        const mutationResults = await sendMultiActions(mutationActions);
        if (addNotesActionIndex !== -1) {
            createdNoteIds = parseAddedNoteIds(
                unwrapMultiActionResult(mutationResults[addNotesActionIndex]),
                notesToCreate.length,
            );
        }
    }

    applyCreatedNoteIds(notesToCreate, createdNoteIds);
    for (const context of syncContexts) {
        if (!context.linesModified) continue;
        await app.vault.modify(context.file, context.lines.join("\n"));
    }

    logSync(
        `Sync finished. Added ${createdNoteIds.length}, modified ${totalModified}, deleted ${orphanedNoteIds.length}.`,
    );
    return {
        added: createdNoteIds.length,
        modified: totalModified,
        deleted: orphanedNoteIds.length,
    };
}

async function loadSyncContexts(
    app: App,
    markdownFiles: TFile[],
    fileDecks: Map<string, string>,
): Promise<FileSyncContext[]> {
    const contexts: FileSyncContext[] = [];
    for (const file of markdownFiles) {
        const deckName = fileDecks.get(file.path);
        if (!deckName) continue;
        const lines = (await app.vault.read(file)).split("\n");
        const notesData = parseDocument(lines, deckName);
        if (notesData.length === 0) continue;
        contexts.push({
            file,
            filePath: file.path,
            deckName,
            lines,
            notesData,
            linesModified: false,
        });
    }
    return contexts;
}

async function loadGlobalReadState(
    syncContexts: FileSyncContext[],
    decksInUse: Set<string>,
): Promise<GlobalReadState> {
    const allExistingNoteIds = [
        ...new Set(
            syncContexts
                .flatMap((context) => context.notesData)
                .map((noteData) => noteData.id)
                .filter((noteId): noteId is number => noteId != undefined),
        ),
    ];
    const deckNames = [...decksInUse];
    const actions: AnkiMultiAction[] = [
        { action: "findNotes", params: { query: `tag:${ANKI_LINK_TAG}` } },
    ];
    const notesInfoActionIndex =
        allExistingNoteIds.length > 0
            ? actions.push({ action: "notesInfo", params: { notes: allExistingNoteIds } }) - 1
            : -1;
    const deckActionIndices = new Map<string, number>();
    for (const deckName of deckNames) {
        const actionIdx =
            actions.push({
                action: "findNotes",
                params: { query: `tag:${ANKI_LINK_TAG} deck:"${escapeAnkiQueryValue(deckName)}"` },
            }) - 1;
        deckActionIndices.set(deckName, actionIdx);
    }

    logSync(`Sending ${actions.length} batched read actions for whole sync run.`);
    const multiRes = await sendMultiRequest(actions);
    if (multiRes.error) {
        throw new Error(`AnkiConnect ${multiRes.error}`);
    }
    if (!Array.isArray(multiRes.result) || multiRes.result.length !== actions.length) {
        throw new Error("AnkiConnect multi returned an unexpected result size");
    }

    const taggedResult = unwrapMultiActionResult(multiRes.result[0]);
    if (!isNumberArray(taggedResult)) {
        throw new Error("AnkiConnect tagged-note lookup returned an unexpected result shape");
    }

    const existingNotesById = new Map<number, NoteInfo>();
    if (notesInfoActionIndex !== -1) {
        const actionResult = unwrapMultiActionResult(multiRes.result[notesInfoActionIndex]);
        if (!Array.isArray(actionResult) || actionResult.length !== allExistingNoteIds.length) {
            throw new Error("AnkiConnect notesInfo returned an unexpected result size");
        }
        const notesInfoItems = actionResult as unknown[];
        for (let i = 0; i < allExistingNoteIds.length; i++) {
            const responseItem = notesInfoItems[i];
            const noteId = allExistingNoteIds[i]!;
            if (isValidNoteInfo(responseItem)) {
                existingNotesById.set(noteId, responseItem);
            }
        }
    }

    const notesInDeckByName = new Map<string, Set<number>>();
    for (const [deckName, actionIdx] of deckActionIndices) {
        const actionResult = unwrapMultiActionResult(multiRes.result[actionIdx]);
        if (!isNumberArray(actionResult)) {
            throw new Error(
                `AnkiConnect deck lookup for "${deckName}" returned an unexpected result shape`,
            );
        }
        notesInDeckByName.set(deckName, new Set(actionResult));
    }

    return {
        taggedNoteIdsAtStart: new Set(taggedResult),
        existingNotesById,
        notesInDeckByName,
    };
}

async function sendMultiActions(actions: AnkiMultiAction[]): Promise<unknown[]> {
    const multiRes = await sendMultiRequest(actions);
    if (multiRes.error) {
        throw new Error(`AnkiConnect ${multiRes.error}`);
    }
    if (!Array.isArray(multiRes.result) || multiRes.result.length !== actions.length) {
        throw new Error("AnkiConnect multi returned an unexpected result size");
    }
    return multiRes.result;
}

function isAnkiActionResponse(value: unknown): value is { error: string | null; result: unknown } {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const obj = value as Record<string, unknown>;
    const error = obj.error;
    return error === null || typeof error === "string";
}

function isNumberArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function unwrapMultiActionResult(item: unknown): unknown {
    if (!isAnkiActionResponse(item)) {
        return item;
    }
    if (item.error) {
        throw new Error(`AnkiConnect multi action failed: ${item.error}`);
    }
    return item.result;
}

function isValidNoteInfo(obj: unknown): obj is NoteInfo {
    if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
        return false;
    }
    const o = obj as Record<string, unknown>;
    const fields = o.fields as Record<string, { value?: string }> | undefined;
    return (
        typeof o.noteId === "number" &&
        fields != null &&
        typeof fields === "object" &&
        typeof fields.Front?.value === "string" &&
        typeof fields.Back?.value === "string"
    );
}

function noteFieldsDiffer(obsidianFields: NoteFields, ankiFields: NoteInfo["fields"]): boolean {
    return (
        obsidianFields.Front !== ankiFields.Front.value ||
        obsidianFields.Back !== ankiFields.Back.value
    );
}

function parseAddedNoteIds(actionResult: unknown, expectedCount: number): number[] {
    if (!Array.isArray(actionResult) || actionResult.length !== expectedCount) {
        throw new Error("AnkiConnect addNotes returned an unexpected result size");
    }
    return actionResult.map((resultNoteId, idx) => {
        if (typeof resultNoteId === "number") {
            return resultNoteId;
        }
        throw new Error(`AnkiConnect failed to create note at batch index ${idx}`);
    });
}

function applyCreatedNoteIds(notesToCreate: PendingNoteCreation[], createdNoteIds: number[]): void {
    if (notesToCreate.length !== createdNoteIds.length) {
        throw new Error("AnkiConnect addNotes returned an unexpected number of note IDs");
    }
    for (let i = 0; i < notesToCreate.length; i++) {
        const pending = notesToCreate[i]!;
        const noteId = createdNoteIds[i]!;
        pending.context.lines[pending.noteData.index] =
            `> [!flashcard] %%${noteId}%% ${pending.noteData.note.fields.Front}`;
        pending.context.linesModified = true;
    }
}

async function ensureDecksExist(deckNames: Set<string>) {
    if (deckNames.size === 0) return;
    const deckNamesRes = await sendDeckNamesRequest();
    if (deckNamesRes.error) throw new Error(`AnkiConnect: ${deckNamesRes.error}`);
    const existingDecks = new Set(deckNamesRes.result);
    for (const deckName of deckNames) {
        if (existingDecks.has(deckName)) continue;
        const createDeckRes = await sendCreateDeckRequest(deckName);
        if (createDeckRes.error) throw new Error(`AnkiConnect: ${createDeckRes.error}`);
    }
}

async function ensureModelIsConfigured() {
    const modelNamesRes = await sendModelNamesRequest();
    if (modelNamesRes.error) throw new Error(`AnkiConnect: ${modelNamesRes.error}`);
    if (!modelNamesRes.result.includes(ANKI_LINK_MODEL_NAME)) {
        const createModelRes = await sendCreateModelRequest(ANKI_LINK_MODEL_NAME);
        if (createModelRes.error) throw new Error(`AnkiConnect: ${createModelRes.error}`);
    }
    const updateTemplatesRes = await sendUpdateModelTemplatesRequest(ANKI_LINK_MODEL_NAME);
    if (updateTemplatesRes.error) throw new Error(`AnkiConnect: ${updateTemplatesRes.error}`);
    const updateStylingRes = await sendUpdateModelStylingRequest(ANKI_LINK_MODEL_NAME);
    if (updateStylingRes.error) throw new Error(`AnkiConnect: ${updateStylingRes.error}`);
}

function parseDocument(lines: string[], deckName: string): ParsedNoteData[] {
    const output = new Array<ParsedNoteData>();
    let i = 0;
    while (i < lines.length) {
        const { id, title } = parsePreamble(lines[i]!) || {};
        if (!title) {
            i++;
            continue;
        }

        const bodyLines = parseBody(lines.slice(i + 1));
        const body = formatBodyForAnki(bodyLines);
        const note = buildNote(title, body, deckName);
        output.push({ id: id ? Number(id) : undefined, index: i, note });
        i += bodyLines.length + 1;
    }
    return output;
}

type BodyToken =
    | { type: "text"; raw: string }
    | { type: "fence"; raw: string; marker: "```" | "~~~" | "$$"; info: string };

type BodySegment =
    | { type: "text"; lines: string[] }
    | { type: "code"; language: string; code: string }
    | { type: "math"; latex: string };

const MATH_INLINE_OPEN = String.raw`\(`;
const MATH_INLINE_CLOSE = String.raw`\)`;
const MATH_BLOCK_OPEN = String.raw`\[`;
const MATH_BLOCK_CLOSE = String.raw`\]`;
const MARKDOWN_PROCESSOR = remark()
    .use(remarkGfm)
    .use(remarkBreaks)
    .use(remarkHtml, { sanitize: false });

function formatBodyForAnki(lines: string[]): string {
    const tokens = lexBody(lines);
    const segments = parseBodyTokens(tokens);
    return renderBodySegments(segments);
}

function lexBody(lines: string[]): BodyToken[] {
    return lines.map((line) => lexLine(line));
}

function lexLine(line: string): BodyToken {
    const trimmed = line.trim();
    if (trimmed === "$$") {
        return { type: "fence", raw: line, marker: "$$", info: "" };
    }
    if (trimmed.startsWith("```")) {
        return { type: "fence", raw: line, marker: "```", info: trimmed.slice(3).trim() };
    }
    if (trimmed.startsWith("~~~")) {
        return { type: "fence", raw: line, marker: "~~~", info: trimmed.slice(3).trim() };
    }
    return { type: "text", raw: line };
}

function parseBodyTokens(tokens: BodyToken[]): BodySegment[] {
    const segments: BodySegment[] = [];
    const textBuffer: string[] = [];

    const flushText = () => {
        if (textBuffer.length === 0) return;
        segments.push({ type: "text", lines: [...textBuffer] });
        textBuffer.length = 0;
    };

    let i = 0;
    while (i < tokens.length) {
        const token = tokens[i]!;
        if (token.type !== "fence") {
            textBuffer.push(token.raw);
            i++;
            continue;
        }

        if (token.marker === "$$") {
            const closingMathIdx = findClosingFenceToken(tokens, i + 1, "$$");
            if (closingMathIdx === -1) {
                textBuffer.push(token.raw);
                i++;
                continue;
            }

            flushText();
            const latex = tokens
                .slice(i + 1, closingMathIdx)
                .map((currentToken) => currentToken.raw)
                .join("\n");
            segments.push({ type: "math", latex });
            i = closingMathIdx + 1;
            continue;
        }

        const closingFenceIdx = findClosingFenceToken(tokens, i + 1, token.marker);
        if (closingFenceIdx === -1) {
            // Keep unmatched fences as regular text to avoid dropping content.
            textBuffer.push(token.raw);
            i++;
            continue;
        }

        flushText();
        const code = tokens
            .slice(i + 1, closingFenceIdx)
            .map((currentToken) => currentToken.raw)
            .join("\n");
        segments.push({ type: "code", language: token.info, code });
        i = closingFenceIdx + 1;
    }

    flushText();
    return segments;
}

function findClosingFenceToken(
    tokens: BodyToken[],
    startIdx: number,
    marker: "```" | "~~~" | "$$",
): number {
    for (let i = startIdx; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token.type === "fence" && token.marker === marker && token.info.length === 0) {
            return i;
        }
    }
    return -1;
}

function renderBodySegments(segments: BodySegment[]): string {
    return segments.map((segment) => renderSegment(segment)).join("\n");
}

function renderSegment(segment: BodySegment): string {
    if (segment.type === "text") {
        return renderMarkdownText(segment.lines);
    }
    if (segment.type === "code") {
        const languageClass =
            segment.language.length > 0
                ? ` class="language-${escapeHtmlAttribute(segment.language)}"`
                : "";
        return `<pre><code${languageClass}>${escapeHtml(segment.code)}</code></pre>`;
    }
    return MATH_BLOCK_OPEN + segment.latex + MATH_BLOCK_CLOSE;
}

function renderMarkdownText(lines: string[]): string {
    const markdown = lines.join("\n");
    const { markdownWithPlaceholders, replacements } = extractInlineMathPlaceholders(markdown);
    let rendered = String(MARKDOWN_PROCESSOR.processSync(markdownWithPlaceholders)).trim();
    for (const [placeholder, replacement] of replacements) {
        rendered = rendered.split(placeholder).join(replacement);
    }
    return rendered;
}

function extractInlineMathPlaceholders(markdown: string): {
    markdownWithPlaceholders: string;
    replacements: Map<string, string>;
} {
    let output = "";
    const replacements = new Map<string, string>();
    let placeholderCounter = 0;
    let i = 0;
    while (i < markdown.length) {
        const inlineCode = consumeInlineCode(markdown, i);
        if (inlineCode) {
            output += inlineCode.text;
            i += inlineCode.length;
            continue;
        }

        const inlineMath = consumeInlineMath(markdown, i, placeholderCounter);
        if (!inlineMath) {
            output += markdown[i]!;
            i++;
            continue;
        }

        output += inlineMath.placeholder;
        replacements.set(inlineMath.placeholder, inlineMath.replacement);
        placeholderCounter = inlineMath.nextPlaceholderCounter;
        i += inlineMath.length;
    }
    return { markdownWithPlaceholders: output, replacements };
}

function consumeInlineCode(
    input: string,
    startIdx: number,
): { text: string; length: number } | null {
    const char = input[startIdx];
    if (char !== "`" || isEscaped(input, startIdx)) return null;

    const tickRunLength = countSameCharRun(input, startIdx, "`");
    const closeTickIdx = findMatchingTickRun(input, startIdx + tickRunLength, tickRunLength);
    if (closeTickIdx === -1) return null;

    const endIdx = closeTickIdx + tickRunLength;
    return { text: input.slice(startIdx, endIdx), length: endIdx - startIdx };
}

function consumeInlineMath(
    input: string,
    startIdx: number,
    placeholderCounter: number,
): {
    placeholder: string;
    replacement: string;
    length: number;
    nextPlaceholderCounter: number;
} | null {
    const char = input[startIdx];
    if (char !== "$" || isEscaped(input, startIdx)) return null;

    const isDoubleDollar = input[startIdx + 1] === "$";
    const openDelimiterLength = isDoubleDollar ? 2 : 1;
    const closeIdx = findInlineMathEnd(input, startIdx + openDelimiterLength, isDoubleDollar);
    if (closeIdx === -1) return null;

    const contentStart = startIdx + openDelimiterLength;
    const latex = input.slice(contentStart, closeIdx);
    const closeDelimiterLength = isDoubleDollar ? 2 : 1;
    const placeholder = `ANKILINK_MATH_${placeholderCounter}_TOKEN`;
    return {
        placeholder,
        replacement: MATH_INLINE_OPEN + latex + MATH_INLINE_CLOSE,
        length: closeIdx + closeDelimiterLength - startIdx,
        nextPlaceholderCounter: placeholderCounter + 1,
    };
}

function countSameCharRun(input: string, startIdx: number, char: string): number {
    let runLength = 0;
    for (let i = startIdx; i < input.length; i++) {
        if (input[i] !== char) break;
        runLength++;
    }
    return runLength;
}

function findMatchingTickRun(input: string, startIdx: number, tickRunLength: number): number {
    let i = startIdx;
    while (i < input.length) {
        if (input[i] !== "`" || isEscaped(input, i)) {
            i++;
            continue;
        }
        if (countSameCharRun(input, i, "`") === tickRunLength) {
            return i;
        }
        i++;
    }
    return -1;
}

function findInlineMathEnd(input: string, startIdx: number, isDoubleDollar: boolean): number {
    for (let i = startIdx; i < input.length; i++) {
        if (input[i] !== "$") continue;
        if (isEscaped(input, i)) continue;
        if (isDoubleDollar) {
            if (input[i + 1] === "$") return i;
            continue;
        }
        if (input[i + 1] === "$") continue;
        return i;
    }
    return -1;
}

function isEscaped(input: string, idx: number): boolean {
    let backslashes = 0;
    for (let i = idx - 1; i >= 0 && input[i] === "\\"; i--) {
        backslashes++;
    }
    return backslashes % 2 === 1;
}

function escapeHtml(value: string): string {
    return value.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;");
}

function escapeHtmlAttribute(value: string): string {
    return value
        .split("&")
        .join("&amp;")
        .split('"')
        .join("&quot;")
        .split("<")
        .join("&lt;")
        .split(">")
        .join("&gt;");
}

function parseBody(lines: string[]) {
    const bodyLines: string[] = [];
    for (const line of lines) {
        // Stop early if we reach another flashcard preamble.
        if (parsePreamble(line)) {
            return bodyLines;
        }
        if (!line.startsWith(">")) {
            return bodyLines;
        }
        bodyLines.push(line.replace(/^>\s?/, ""));
    }
    return bodyLines;
}

function parsePreamble(str: string) {
    const match = FC_PREAMBLE_P.exec(str);
    if (!match) {
        return undefined;
    }
    return { id: match[1], title: match[2]! };
}

function escapeAnkiQueryValue(value: string): string {
    return value.split('"').join(String.raw`\"`);
}

async function getDeckNameForFile(app: App, file: TFile): Promise<string | undefined> {
    let deckName: string | undefined;
    try {
        await app.fileManager.processFrontMatter(file, (frontMatter) => {
            const metadata = frontMatter as Record<string, unknown>;
            const configuredDeck = metadata["anki deck"];
            deckName =
                typeof configuredDeck === "string" && configuredDeck.trim().length > 0
                    ? configuredDeck.trim()
                    : undefined;
        });
        return deckName;
    } catch {
        return undefined;
    }
}
