export interface AnkiActionResponse<T> {
    error: string | null;
    result: T;
}

export interface AnkiMultiAction {
    action: string;
    params?: unknown;
}

export interface NoteFields {
    Front: string;
    Back: string;
}

export interface Note {
    deckName: string;
    modelName: string;
    fields: NoteFields;
    tags: string[];
    options: {
        allowDuplicate: boolean;
    };
}

export interface NoteInfo {
    noteId: number;
    modelName: string;
    tags: string[];
    cards: number[];
    fields: {
        Front: { value: string; order: number };
        Back: { value: string; order: number };
    };
}

export interface CreateModelInput {
    modelName: string;
    inOrderFields: string[];
    css: string;
    cardTemplates: Array<{
        Name: string;
        Front: string;
        Back: string;
    }>;
    isCloze: boolean;
}
