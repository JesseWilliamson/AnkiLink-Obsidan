export const FC_PREAMBLE_P = /^>\s*\[!flashcard\]\s*(?:%%(\d+)%%)?\s*(.*)$/;
export const FC_CALLOUT_LENGTH = 14;

export function splitCalloutBody(body: string) {
    const lines = body.split(">");
    lines.shift(); // All bodies will start with a > and a space
    return lines.join("<br>");
}
