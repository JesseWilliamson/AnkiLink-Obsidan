# Anki Link for Obsidian

Turn your Obsidian notes into synced Anki flashcards for better retention.

## Why this plugin?

- Write flashcards inline in your notes using callouts.
- Obsidian is treated as a single source of truth for generated flashcards, which are kept up-to-date with their obsidian sources.
- Support rich card bodies including:
    - Markdown formatting (lists, emphasis, tables, etc.)
    - Code blocks
    - Inline and block math with Latex

## Setup

1. Install the plugin in Obsidian
2. Install [Anki Connect Plus](https://ankiweb.net/shared/info/2036732292) in Anki
3. In Anki, navigate to Tools -> Addons -> AnkiConnect -> Config, and add `app://obsidian.md` to the `webCordOriginList` like this:

```
{
    "apiKey": null,
    "apiLogPath": null,
    "webBindAddress": "127.0.0.1",
    "webBindPort": 8765,
    "webCorsOrigin": "http://localhost",
    "webCorsOriginList": [
        "http://localhost",
        "app://obsidian.md"
    ]
}
```

Each flashcard starts with a callout line and continues with quoted body lines:

````
> [!flashcard] Explain Big-O for binary search.
> Binary search runs in **O(log n)** time.
>
> At each step, it halves the search space:
> ```text
> n -> n/2 -> n/4 -> n/8 ...
> ```
>
> Approximate steps:
> $$
> \text{steps} \approx \log_2(n)
> $$
````

### Notes

- Every flashcard body line must start with `>`.
- The plugin writes `%%<anki-note-id>%%` after the flashcard title after first sync. This won't be visible in Obsidian unless you're editing the flashcard callout.
- Removing a flashcard from your notes removes the linked Anki note on sync.

## Commands

- `Sync cards` - Syncs all vault flashcards to Anki, updating, creating, moving, and deleting as needed.
- `Add flashcard` - Inserts the flashcard preamble template at the cursor.

## How deck mapping works

- Deck is read per file from frontmatter key: `anki deck`.
- If the deck does not exist in Anki, it is created automatically.
- Existing cards are moved to the configured deck if needed.

## Custom Anki note type

The plugin targets a model named `AnkiLink Basic` and ensures it exists.  
On sync, it updates that model's templates/CSS so formatting stays consistent across cards.
