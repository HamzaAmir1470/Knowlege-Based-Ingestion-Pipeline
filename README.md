# AI Knowledge Ingestion Pipeline

A NestJS pipeline that turns a PDF into retrieval-ready knowledge, with a browser dashboard that shows every stage as it runs.

This project extends the AI PDF Ingestion lesson. It does **not** use a vector database or embeddings yet. Those come in the next RAG videos. Today the focus is ingestion and chunk generation.

```
PDF -> Parse -> Markdown -> Metadata -> Clean -> Recursive chunks
                                              -> Semantic chunks
                                              -> Parent-child tree -> Gemini summary -> JSON
```

## 1. Quick start

You need Node.js 20 or newer.

```bash
npm install
cp .env.example .env        # the zip already contains a .env, so you can skip this
```

Open `.env` and set your key:

```
GEMINI_API_KEY=your_real_key_here
```

Get a free key at https://aistudio.google.com/apikey

Start the server:

```bash
npm run start:dev
```

Open **http://localhost:3000** in your browser.

## 2. Test it in the browser (no Postman needed)

1. Open http://localhost:3000.
2. Click **Try the sample PDF**, or drop your own text-based PDF on the upload box.
3. Watch the **Processing timeline** on the left. Each stage turns amber while it runs, then green.
4. Results fill in on the right while the pipeline works:
   - **Overview**: Gemini summary, metadata card, chunk statistics, cleaning report
   - **Markdown**: original and cleaned Markdown, rendered or as source, with copy and download
   - **Recursive chunks**: search, filter by split level, expand any chunk
   - **Semantic chunks**: each chunk shows why it started and which rules kept its paragraphs together
   - **Parent-child tree**: every parent with its children listed below it
5. In the chunk statistics card, each bar is one chunk. Click a bar to jump to that chunk.

The demo pauses 450 ms after each local stage so you can follow along. Set `STAGE_DELAY_MS=0` in `.env` to run at full speed.

If `GEMINI_API_KEY` is missing or wrong, the summary card shows the error and everything else still works.

## 3. How the architecture works

One orchestrator service calls small single-purpose services in order. Each service takes plain data in and returns plain data out. None of them know about HTTP.

```
                      +-------------------------+
 Browser  --POST-->   |      AiController       |
                      +------------+------------+
                                   |
                      +------------v------------+
                      | IngestionPipelineService|  (order, timing, progress events)
                      +------------+------------+
   +--------+---------+------------+-----------+--------------+
   |        |         |            |           |              |
 PdfParser  Markdown  Metadata   TextCleaner  Recursive     Semantic
 Service    Converter Extractor  Service      Chunker       Chunker
                                                 |
                                         ParentChildService ----> GeminiSummaryService
```

The controller offers two endpoints that share the same pipeline:

| Endpoint | Returns | Used by |
|---|---|---|
| `POST /ai/upload` | One JSON object after all stages finish | Any HTTP client |
| `POST /ai/upload/stream` | One JSON event per line (NDJSON) while stages run | The dashboard |

Both accept `multipart/form-data` with a PDF in the `file` field.

## 4. Folder structure

```
ai-knowledge-ingestion/
├── package.json
├── tsconfig.json / tsconfig.build.json / nest-cli.json
├── .env                      your local settings (do not commit)
├── .env.example              every setting with comments
├── scripts/
│   └── smoke-test.ts         runs the pipeline in the terminal, no server needed
├── public/                   the dashboard, served by Nest at "/"
│   ├── index.html            layout, Tailwind config, styles
│   ├── app.js                upload, stream reader, rendering
│   └── sample/rag-fundamentals.pdf
└── src/
    ├── main.ts               starts Nest and serves /public
    ├── app.module.ts         loads config and the AI module
    ├── config/app.config.ts  reads .env, sets defaults
    └── ai/
        ├── ai.module.ts      wires services and Multer (memory storage, PDF filter, size limit)
        ├── ai.controller.ts  the two upload endpoints
        ├── interfaces/ingestion.types.ts   every type and the JSON contract
        ├── utils/
        │   ├── text.util.ts       sentences, keywords, token estimate, packing helpers
        │   └── markdown.util.ts   Markdown blocks and sections parser
        └── services/
            ├── ingestion-pipeline.service.ts   the orchestrator
            ├── pdf-parser.service.ts
            ├── markdown-converter.service.ts
            ├── metadata-extractor.service.ts
            ├── text-cleaner.service.ts
            ├── recursive-chunker.service.ts
            ├── semantic-chunker.service.ts
            ├── parent-child.service.ts
            └── gemini-summary.service.ts
```

## 5. What each important file does

**`ingestion-pipeline.service.ts`**
Runs the stages in order, times each one, and emits progress events. A small `stage()` helper wraps every stage, so adding a new stage takes about five lines. If the Gemini stage fails, the pipeline still returns everything else.

**`pdf-parser.service.ts`**
Uses `pdf-parse` and adds a custom page renderer. The renderer records each line's font size and whether a paragraph gap came before it. Plain text alone cannot tell a heading from a paragraph, so these hints matter.

**`markdown-converter.service.ts`**
Turns lines into Markdown. It finds headings in three ways: font size first, then numbering such as `2.1 Chunk size`, then shape (short ALL CAPS or Title Case lines that stand alone). It also builds lists, joins wrapped lines into paragraphs, and repairs words split by a hyphen at a line break.

**`metadata-extractor.service.ts`**
Reads title, author and dates from the PDF. It also computes word count, reading time, heading count, language guess and top keywords.

**`text-cleaner.service.ts`**
Runs eight small cleaning steps and records how many items each step fixed. Steps include normalizing characters, removing page numbers, and removing headers and footers that repeat on most pages. Each step is a plain function, so you can add your own.

**`recursive-chunker.service.ts`**
Splits by the biggest natural boundary first: section, then paragraph, then line, then sentence, then word. It merges small neighbours up to `CHUNK_SIZE`. Headings never end a chunk alone. Each chunk repeats a short overlap from the chunk before it.

**`semantic-chunker.service.ts`**
Groups paragraphs with plain rules and no embeddings:

- A new heading starts a new chunk. Small `###` sub-headings stay with their parent until the chunk reaches the minimum size.
- A list or code block stays with the paragraph that introduces it.
- A paragraph that starts with words like "However" or "This" continues the previous idea.
- A chunk splits when it would pass the maximum size.
- Once a chunk reaches the minimum size, a paragraph that shares few keywords with the last two paragraphs starts a new chunk (a topic shift).

Every chunk records its start reason and the rules that applied, so students can see why it looks the way it does.

**`parent-child.service.ts`**
Builds parents from sections (headings up to `PARENT_HEADING_LEVEL`). It then splits each parent into small child chunks. Parent shape:

```json
{
  "id": "parent-003",
  "title": "1. Why RAG Exists",
  "markdown": "## 1. Why RAG Exists\n\n...",
  "childChunks": [
    { "id": "parent-003-child-001", "content": "...", "parentId": "parent-003" }
  ]
}
```

**`gemini-summary.service.ts`**
Sends the cleaned Markdown to Gemini 2.5 Flash and asks for JSON through a response schema. It retries up to three times when Gemini is busy.

**`public/app.js`**
Reads the NDJSON stream with `fetch` and `ReadableStream`. Each event updates one `state` object, then small render functions redraw the timeline and panels. All text is escaped before it goes into the page.

## 6. Settings

All settings live in `.env`. Defaults are tuned for the sample PDF.

| Setting | Default | Meaning |
|---|---|---|
| `CHUNK_SIZE` | 800 | Target size of a recursive chunk in characters |
| `CHUNK_OVERLAP` | 100 | Characters copied from the previous chunk |
| `SEMANTIC_MIN_CHARS` | 300 | Topic shifts only split after this size |
| `SEMANTIC_MAX_CHARS` | 1200 | A semantic chunk never grows past this |
| `SEMANTIC_SIMILARITY_THRESHOLD` | 0.12 | Higher values split more often |
| `PARENT_HEADING_LEVEL` | 2 | Parents start at `#` and `##` headings |
| `PARENT_MAX_CHARS` | 3000 | Larger parents are split into parts |
| `CHILD_CHUNK_SIZE` | 400 | Target size of a child chunk |
| `STAGE_DELAY_MS` | 450 | Demo pause after each local stage |
| `MAX_FILE_SIZE_MB` | 10 | Upload limit |

Change a value, restart the server, and upload the same PDF again to compare results.

## 7. Terminal check without the browser

```bash
npm run smoke
npm run smoke -- path/to/your.pdf
```

## 8. Limits to know about

- **Scanned PDFs** have no text layer. The app returns a clear error. OCR is outside this lesson.
- **Heading detection** is rule based. Documents with unusual layouts may need rule tweaks in `markdown-converter.service.ts`.
- **Tables** from PDFs come out as plain text lines.
- **Token counts** are estimates (characters divided by four).
- **Tailwind** loads from its Play CDN so the lesson needs no build step. For production, compile Tailwind with its CLI.
- Files stay in memory and nothing is saved to disk or a database.

## 9. Where this goes next

Children are the units you will embed. At query time you search children and return their parents to the model. The `Chunk`, `ChildChunk` and `ParentChunk` types in `ingestion.types.ts` are ready for that step.

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| Summary card shows "GEMINI_API_KEY is missing" | Set the key in `.env` and restart |
| Summary card shows a 429 or quota error | Wait a minute or check your Gemini quota |
| "No text found in this PDF" | The PDF is scanned. Use a text-based PDF |
| Fonts or styles look plain | The browser needs internet access for the Tailwind and Google Fonts CDNs |
| Port already in use | Change `PORT` in `.env` |
