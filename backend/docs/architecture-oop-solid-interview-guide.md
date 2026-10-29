# Backend Architecture, OOP and SOLID — Interview Guide

This guide explains how the Aadhaar OCR backend is structured and why. It is
written in the first person, the way I would explain it in an interview. Every
claim points to a file in `backend/src`; where the design is weaker than the
textbook version, the guide says so.

## 1. Overview

The backend is an Express 5 + TypeScript API that takes two images (the front
and back of an Aadhaar card), runs OCR on them with Tesseract.js, and returns
parsed, masked fields. It stores nothing: uploads stay in memory as `Buffer`s
(`middlewares/upload.middleware.ts` uses `multer.memoryStorage()`), raw OCR
text is never returned (`controllers/ocr.controllers.ts`), and the Aadhaar
number is masked to its last four digits (`maskAadhaarNumber` in
`services/aadhaar-parser.rules.ts`).

Endpoints:

| Method | Path | Handler |
|---|---|---|
| `POST` | `/api/ocr` | `OcrController.extract` |
| `GET` | `/api/health` | `HealthController.health` (liveness, no OCR work) |
| `GET` | `/api/ready` | `HealthController.ready` (is an OCR engine started?) |

Layout:

| Folder | Responsibility |
|---|---|
| `config/` | `env.ts` (Zod-validated environment), `paths.ts`, `container.ts` (composition root) |
| `app.ts`, `server.ts` | `App` class builds Express; `server.ts` owns the process lifecycle |
| `routes/` | `OcrRoute`, `HealthRoute` classes that expose `getRouter()` |
| `controllers/` | HTTP-only classes |
| `middlewares/` | Capacity reservation, upload, domain-error translation, error handler |
| `services/` | Extraction workflow, parser wrapper, pure parsing rules |
| `services/ocr/` | OCR service facade, capacity, worker pool, recognition pipeline, Tesseract adapter, errors |
| `services/interfaces/` | `I`-prefixed contracts |
| `validators/`, `utils/`, `constants/`, `types/` | Upload validation, pure helpers, messages/status codes, shared types |

## 2. Request flow and dependency flow

### Request flow for `POST /api/ocr`

```
app.ts  cors → express.json
  └─ OcrRoute (routes/ocr.routes.ts)
       1. reserveOcrCapacity      middlewares/ocr-capacity.middleware.ts
            admission.reserve(2) → OcrReservation in res.locals
            (throws OcrError BUSY / UNAVAILABLE before any upload is buffered)
       2. uploadAadhaarImages     middlewares/upload.middleware.ts
            multer memory storage, size/count limits, MIME + extension filter
       3. OcrController.extract   controllers/ocr.controllers.ts
            validateAadhaarImages (validators/upload.validator.ts)
            AbortController tied to res "close"
            └─ ExtractAadhaarDetailsService.execute
                 ├─ ITextRecognizer.recognizeText × 2  (Promise.allSettled)
                 │    OcrService → assertImageCanBeProcessed
                 │               → OcrWorkerPool.run → RecognitionPipeline.recognize
                 │                                      → IOcrEngine.recognize (Tesseract)
                 └─ IAadhaarParser.parse → parseAadhaar (pure rules)
  errors → notFoundHandler → translateDomainErrors → errorHandler
```

### Dependency (construction) flow

Everything is built once in `config/container.ts`, which is imported by
`server.ts` after `config/env.ts` has validated the environment:

```
TesseractEngineFactory ─┐
                        ├─ OcrWorkerPool ─┐
OcrCapacity ────────────┼─────────────────┼─ OcrService ─┬─ ExtractAadhaarDetailsService ─ OcrController
RecognitionPipeline ────┘ (numberEvidence: │             │        ▲
  hasAadhaarNumberEvidence,               │             │  AadhaarParserService
  isNumberEvidenceLine)                   │             ├─ HealthController (as IOcrHealth)
                                          │             ├─ createReserveOcrCapacity (as IOcrAdmission)
                                          │             └─ server.ts (as IOcrLifecycle)
```

`server.ts` then does `new App(container).getApp()`, and `App` creates the
route objects from the controllers and middleware in the container.

## 3. OOP map

### Encapsulation

- `services/ocr/ocr-capacity.ts`: `OcrCapacity` keeps `#jobsInFlight` and
  `#closed` in ES private fields. The only ways to change them are `reserve`,
  `startJob`, `finishJob`, `returnUnused` and `close`.
- `OcrReservation` (same file) keeps `#capacity` and `#remaining` private.
  Because it has private fields, a plain object of the same shape is not
  assignable to it, and `startJob` additionally checks
  `reservation instanceof OcrReservation` and that `take(this)` succeeds for
  this exact capacity. `release()` is idempotent.
- `services/ocr/ocr-worker-pool.ts`: `OcrWorkerPool` hides `#engines`,
  `#freeSlots`, `#waiting`, `#status`, `#closed` and the private methods
  `#acquireSlot`, `#releaseSlot`, `#getEngine`, `#discardEngine`.
- `TesseractOcrEngine` hides `#threadExited`.
- Controllers and services use TypeScript `private readonly` constructor
  parameters. These are compile-time only, unlike `#fields`, which are
  enforced at runtime.

> "The concurrency counters are the riskiest state in the app. I made them
> runtime-private so nothing outside `OcrCapacity` and `OcrWorkerPool` can
> desynchronise them. A request only ever holds an `OcrReservation`, and it
> can only spend that reservation through the capacity that issued it."

### Abstraction

Nine interfaces in five files in `services/interfaces/`:

| Interface | File | Consumer |
|---|---|---|
| `IOcrEngine` | `IOcrEngine.services.ts` | `OcrWorkerPool`, `RecognitionPipeline` (via `EngineLease`) |
| `IOcrEngineFactory` | `IOcrEngine.services.ts` | `OcrWorkerPool` |
| `ITextRecognizer` | `IOcr.services.ts` | `ExtractAadhaarDetailsService` |
| `IOcrAdmission` | `IOcr.services.ts` | `createReserveOcrCapacity` |
| `IOcrHealth` | `IOcr.services.ts` | `HealthController` |
| `IOcrLifecycle` | `IOcr.services.ts` | `server.ts` |
| `INumberEvidence` | `INumberEvidence.services.ts` | `RecognitionPipeline` |
| `IAadhaarParser` | `IAadhaarParser.services.ts` | `ExtractAadhaarDetailsService` |
| `IAadhaarExtractionService` | `IAadhaarExtraction.services.ts` | `OcrController` |

> "The extraction workflow doesn't know Tesseract, worker slots or regexes
> exist. It sees 'something that recognises text' and 'something that parses
> two OCR results'."

### Inheritance

Inheritance is used only for errors. Every `extends` in `backend/src` extends
`Error`:

- `services/ocr/ocr.errors.ts`: `OcrAbortedError`, `ImageDecodeError`,
  `LanguageDataError`, `OcrError`
- `services/extract-aadhaar-details.services.ts`: `NotAadhaarCardError`
- `utils/http-error.ts`: `HttpError`
- private to their modules: `QueueTimeoutError`, `ShutdownError`
  (`ocr-worker-pool.ts`) and `OcrTimeoutError` (`recognition-pipeline.ts`)

There are no domain class hierarchies.

> "I don't use inheritance for behaviour reuse; I use composition. Errors
> extend `Error` because the platform expects it: stack traces, `cause`, and
> `instanceof` checks in the error middleware all depend on it."

### Polymorphism

It helps to be precise about four different claims:

1. **A class implements an interface.** True for five classes:
   - `OcrService implements ITextRecognizer, IOcrAdmission, IOcrHealth, IOcrLifecycle`
   - `TesseractEngineFactory implements IOcrEngineFactory`
   - `TesseractOcrEngine implements IOcrEngine`
   - `AadhaarParserService implements IAadhaarParser`
   - `ExtractAadhaarDetailsService implements IAadhaarExtractionService`
2. **A dependency is typed as an interface.** True for the consumers in the
   abstraction table above.
3. **Several implementations exist.** **Not true.** Each interface currently
   has exactly one production implementation, and there are no test doubles
   in the repository. `INumberEvidence` is satisfied structurally by a plain
   object literal of two pure functions in `container.ts`; there is no class
   implementing it.
4. **More implementations are possible without changing consumers.** True by
   design. For example, a different `IOcrEngineFactory` would change one line
   in `container.ts`, and `OcrWorkerPool` would not change.

The one place where one object really is used through different types is
`OcrService`: the same instance is seen as `IOcrHealth` by `HealthController`,
as `IOcrAdmission` by the capacity middleware, as `IOcrLifecycle` by
`server.ts`, and as `ITextRecognizer` by the extraction service.

> "It's polymorphism by design, not yet in practice. I wouldn't claim I swap
> implementations at runtime; I'd say the seams are there for a second OCR
> engine or for test fakes."

### Composition and dependency injection

- `OcrService` is composed of `OcrCapacity`, `OcrWorkerPool` and
  `RecognitionPipeline` (`OcrServiceDependencies` in `ocr.services.ts`) and
  only delegates to them.
- `OcrWorkerPool` is composed with an `IOcrEngineFactory`.
- `RecognitionPipeline` is composed with `INumberEvidence`.
- All collaborators arrive through constructors, and only
  `config/container.ts` calls `new` on them. Middleware is also built by
  factories that receive their dependencies (`createReserveOcrCapacity(admission)`,
  `createUploadAadhaarImages(limits)`).

### Pure functions (not OOP)

- `services/aadhaar-parser.rules.ts`: `parseAadhaar`, `hasAadhaarNumberEvidence`,
  `isNumberEvidenceLine`, plus private helpers.
- `utils/verhoeff.ts` (checksum), `utils/image-header.ts` (format, dimensions,
  EXIF orientation), and `validators/upload.validator.ts`.

> "The parsing rules take text and return data, with no state and no I/O, so
> I kept them as functions. They're the easiest part of the system to test
> and reason about."

## 4. SOLID map

### S — Single Responsibility

| Unit | Single reason to change |
|---|---|
| `OcrController` | HTTP shape of the OCR endpoint |
| `HealthController` | Liveness/readiness response format |
| `ExtractAadhaarDetailsService` | The two-sided extraction workflow |
| `aadhaar-parser.rules.ts` | How Aadhaar fields are recognised in text |
| `OcrCapacity` / `OcrReservation` | Admission control |
| `OcrWorkerPool` | Concurrency, queueing, engine lifecycle |
| `RecognitionPipeline` | The OCR passes for one image |
| `TesseractEngineFactory` / `TesseractOcrEngine` | Tesseract specifics |
| `domain-error.middleware.ts` | Mapping domain errors to HTTP |

Limitation: `OcrService` is the widest class. It implements four role
interfaces and also runs `assertImageCanBeProcessed`. It mostly delegates,
but it is the class with the most reasons to change.

### O — Open/Closed

- Adding another OCR engine means writing a new `IOcrEngineFactory` /
  `IOcrEngine` pair and changing the line in `container.ts` that creates the
  factory. `OcrWorkerPool`, `RecognitionPipeline`, `OcrService` and the
  extraction service stay unchanged.
- Limitations: adding a new `OcrErrorCode` requires editing
  `OCR_ERROR_RESPONSES`. Because it is typed `Record<OcrErrorCode, …>`, the
  compiler forces that edit, which I prefer to silent fallthrough. Changing a
  parsing rule means editing `aadhaar-parser.rules.ts`. These are deliberate
  modifications, not extensions.

### L — Liskov Substitution

- Evidence: the `Error` subclasses can be used wherever an `Error` is
  expected. `errorHandler` handles any of them, and `OcrError.forSide`
  returns another `OcrError` with the original as `cause`.
- **LSP is not fully demonstrated for the interfaces.** Each interface has a
  single production implementation, and the backend has no permanent
  automated test suite. `implements` only proves that the method signatures
  match; it doesn't prove that a second implementation would honour the
  behavioural contract (for example, that an `IOcrEngine` throws
  `ImageDecodeError` for undecodable images, which `RecognitionPipeline`
  relies on). Those expectations are partly documented in comments and not
  enforced by tests.

### I — Interface Segregation

`IOcr.services.ts` splits the OCR service into four role interfaces, one per
kind of consumer. `HealthController` can only call `readiness()`; the capacity
middleware can only call `reserve()`; `server.ts` can only call `warmUp`,
`beginShutdown` and `shutdown`. `INumberEvidence` gives the pipeline two
parser rules without exposing the whole parser.

### D — Dependency Inversion

- Depends on abstractions: `ExtractAadhaarDetailsService` (`ITextRecognizer`,
  `IAadhaarParser`), `OcrController` (`IAadhaarExtractionService`),
  `HealthController` (`IOcrHealth`), `createReserveOcrCapacity`
  (`IOcrAdmission`), `server.ts` (`IOcrLifecycle`), `OcrWorkerPool`
  (`IOcrEngineFactory`), `RecognitionPipeline` (`INumberEvidence`).
- Depends on concrete types (limitations):
  - `OcrRoute` and `HealthRoute` take the concrete controller classes.
  - `AppDependencies` in `app.ts` lists the concrete controller types.
  - `OcrServiceDependencies` lists concrete `OcrCapacity`, `OcrWorkerPool`
    and `RecognitionPipeline`.
  - `RecognitionPipeline.recognize` takes `EngineLease`, which is exported
    from `ocr-worker-pool.ts`.
  - The interfaces live in `services/interfaces/` rather than being owned by
    each consumer.

### DI vs DIP

> "Dependency injection is the mechanism: objects receive collaborators
> through their constructors, and the container builds the graph. Dependency
> inversion is the principle: high-level policy should depend on
> abstractions, not on details. They're independent. `OcrRoute` is injected
> with a concrete `OcrController`, which is DI without DIP. The extraction
> service is injected with `ITextRecognizer` and `IAadhaarParser`, which is
> both."

## 5. Interview questions and answers

**Q1. Walk me through what happens when a request hits `POST /api/ocr`.**
"First, the capacity middleware reserves two OCR jobs, so if the service is
full the client gets a 503 before I buffer any file. Then Multer reads
exactly two image fields into memory with size and type limits. The
controller validates that both images are present, non-empty, actually
JPEG/PNG by their bytes, and not identical. It ties an `AbortController` to
the response closing and calls the extraction service. That service
recognises both images concurrently through the worker pool, parses them
together, and rejects text that doesn't look like an Aadhaar card. The
controller returns only masked, parsed fields."

**Q2. Where do you use encapsulation, and why does it matter here?**
"In `OcrCapacity`, `OcrReservation` and `OcrWorkerPool`, using `#private`
fields. These hold counters and queues that must stay consistent under
concurrent requests. Making them runtime-private means the only way to change
them is through methods that keep the invariants, for example `release()`
being safe to call twice."

**Q3. Where do you use inheritance?**
"Only for error types, all extending `Error`. Business behaviour is built by
composition: `OcrService` is composed of a capacity, a pool and a pipeline.
I'd rather swap a collaborator than override a method."

**Q4. Do you have polymorphism if every interface has one implementation?**
"Partly. The consumers are written against interfaces, so the polymorphic
seam exists, and `OcrService` is genuinely used through four different
interface types. But I don't have two implementations of any interface in
production today, so I wouldn't claim runtime substitution. The value right
now is decoupling and the option to add a second engine or a test fake."

**Q5. Why are the parsing rules pure functions and not a class?**
"They have no state and no I/O: OCR results in, fields out. A class would add
nothing. `AadhaarParserService` exists only so the workflow can depend on
`IAadhaarParser` and be given a different parser."

**Q6. How do you apply SRP?**
"Each unit has one reason to change: the controller for HTTP, the extraction
service for the workflow, the rules for recognising fields, the pool for
concurrency, the pipeline for OCR passes, the Tesseract adapter for library
details. The honest exception is `OcrService`, which is a facade over four
roles. It only delegates, but it's the widest class."

**Q7. Give an example of OCP in this codebase.**
"Switching OCR engines. The pool depends on `IOcrEngineFactory`, so a new
engine is a new factory and a one-line change in the container. Where I
deliberately don't follow OCP is the error table: adding an error code means
editing `OCR_ERROR_RESPONSES`, and the `Record` type makes the compiler force
that edit."

**Q8. Is your code LSP-compliant?**
"For the error subclasses, yes: anywhere an `Error` is handled, my subclasses
work. For the interfaces, I can't prove it. Each has one implementation and
the backend has no permanent test suite, so all I know is that the signatures
match. A real LSP check would be a shared contract test run against every
implementation, for example checking that an engine raises `ImageDecodeError`
for undecodable bytes."

**Q9. How do you apply ISP?**
"The OCR service implements four small interfaces. The health controller only
gets `IOcrHealth`, so it literally can't start OCR work; the middleware only
gets `reserve()`; the server only gets lifecycle methods."

**Q10. How do you apply DIP, and where don't you?**
"The extraction service, both controllers' service dependencies, the
middleware, the pool and the pipeline all depend on interfaces. The routes
and `App` depend on the concrete controller classes, and `OcrService`
depends on the concrete capacity, pool and pipeline. Those are internal to
one module and have one implementation, so I accepted the coupling."

**Q11. What's the difference between DI and DIP?**
"DI is how objects get their dependencies, through constructors in my case.
DIP is about what those dependencies are: abstractions rather than details.
`OcrRoute` receiving a concrete `OcrController` is DI without DIP."

**Q12. Why does the container construct concrete classes? Isn't that coupling?**
"Something has to choose implementations; that's the composition root's job.
Putting every `new` in `config/container.ts` keeps that decision in one
place, after the environment has been validated, instead of spreading it
through the code."

**Q13. Why is there no repository layer?**
"There's no persistence. Images stay in memory for the request, and nothing
is written to disk or a database. A repository would be an abstraction over
nothing, and avoiding storage is also a privacy requirement for identity
documents."

**Q14. Why keep domain errors separate from HTTP errors?**
"Services throw `OcrError` with codes like `BUSY` or `TIMEOUT` and no HTTP
knowledge. `translateDomainErrors` is the one place that maps them to a status
and a safe message. The services stay usable outside Express, and only errors
explicitly marked `expose` reach the client."

**Q15. What happens if the server gets more requests than it can handle?**
"Admission control rejects them early. `OcrCapacity.reserve` checks and
increments synchronously, so concurrent requests can't all pass the check,
and it throws `BUSY` before the upload is buffered. Jobs that are admitted
wait for a worker slot for at most `OCR_QUEUE_TIMEOUT_MS`, and then also get
`BUSY`. Memory and CPU are bounded either way."

**Q16. What happens if Tesseract hangs?**
"Each image has a time limit (`OCR_TIMEOUT_MS`) shared by all its passes. If
it's exceeded, the pipeline discards that engine through
`EngineLease.discard()` and returns `TIMEOUT` (503). The slot gets a fresh
engine on its next job, so one bad image can't poison a worker."

**Q17. What happens when the client disconnects mid-request?**
"The controller aborts its `AbortController` when the response closes before
finishing. A job still waiting in the queue leaves it at once; a running pass
finishes, but no further passes start. The controller catches
`OcrAbortedError` and returns silently, because nobody is waiting for a
response."

**Q18. How does graceful shutdown work?**
"On SIGINT or SIGTERM, `server.ts` calls `beginShutdown()`, which closes
admission and rejects queued jobs; running jobs may finish. Then
`server.close()` stops new connections and, once they drain, `shutdown()`
terminates all engines. A grace timer of `OCR_TIMEOUT_MS + 5s` forces an exit
so the process never hangs."

**Q19. How did you verify the refactor didn't change behaviour?**
"I built a temporary regression suite outside the repository and ran it
against both the original commit and the refactored code, and a separate
startup test for missing language data. Both passed on both versions. Those
suites were temporary and have since been removed, so the repository has no
permanent automated tests. That's the biggest gap I'd close next."

## 6. Walkthrough: `IAadhaarParser` and `AadhaarParserService`

```ts
// services/interfaces/IAadhaarParser.services.ts
export interface IAadhaarParser {
  parse(front: OcrResult, back: OcrResult): AadhaarParseResult;
}

// services/aadhaar-parser.services.ts
export class AadhaarParserService implements IAadhaarParser {
  parse(front: OcrResult, back: OcrResult): AadhaarParseResult {
    return parseAadhaar(front, back);
  }
}
```

- The rules live in `aadhaar-parser.rules.ts`. `parseAadhaar` collects
  candidates from both sides and accepts a field only when exactly one
  distinct value is found (`resolve`). Otherwise the field is `null`, so it
  never guesses. It masks the number, computes per-side mean confidence of
  the words used, and sets `documentDetected` from UIDAI branding, the
  government header, number evidence and identity fields.
- The service is a thin adapter: the workflow needs an object it can inject,
  and the rules are best kept as pure functions.
- Two rule functions, `hasAadhaarNumberEvidence` and `isNumberEvidenceLine`,
  are also given to `RecognitionPipeline` as `INumberEvidence`, so the OCR
  layer can decide on the number-recovery pass without depending on the whole
  parser.
- One implementation exists. The interface is a seam, not a plugin system.

## 7. Walkthrough: `ExtractAadhaarDetailsService` and DI

```ts
// services/extract-aadhaar-details.services.ts
export class ExtractAadhaarDetailsService implements IAadhaarExtractionService {
  constructor(
    private readonly recognizer: ITextRecognizer,
    private readonly parser: IAadhaarParser,
  ) {}
  ...
}

// config/container.ts
const extractAadhaarDetailsService = new ExtractAadhaarDetailsService(
  ocrService,
  aadhaarParserService,
);
const ocrController = new OcrController(extractAadhaarDetailsService);
```

- `execute` recognises both images with `Promise.allSettled`, so both jobs
  settle before an error is thrown. The first failure wins, and an `OcrError`
  is re-attributed with `forSide("frontImage" | "backImage")`, so the client
  sees for example `frontImage: <message>`.
- It then parses, and throws `NotAadhaarCardError` (mapped to 422) if
  `documentDetected` is false.
- It has no Express imports. The controller passes the reservation and abort
  signal in `OcrJobOptions`, so the workflow could run outside HTTP.
- DI: both dependencies are interfaces, injected by the container. The
  `ocrService` instance is passed as an `ITextRecognizer`, which is the only
  slice of it this class can use.

## 8. Why there is no repository layer

- Nothing is persisted. Uploads are `Buffer`s in memory
  (`multer.memoryStorage()`), and the response contains only parsed, masked
  fields.
- There is no database dependency in `package.json` (dependencies: cors,
  dotenv, express, multer, tesseract.js, zod).
- The restaurant-listing project this structure was aligned with has
  repositories because it has a database. Copying that layer here would add
  empty abstractions.
- If persistence were ever needed (for example audit logs without personal
  data), it would go behind a new interface injected by the container,
  without changing the extraction workflow.

## 9. Domain errors vs HTTP errors

| Layer | Type | File |
|---|---|---|
| Domain | `OcrError(code, { side, maxDimension })`, `NotAadhaarCardError`, `OcrAbortedError` | `services/ocr/ocr.errors.ts`, `services/extract-aadhaar-details.services.ts` |
| Boundary | `translateDomainErrors` → `toHttpError` using `OCR_ERROR_RESPONSES` | `middlewares/domain-error.middleware.ts` |
| HTTP | `HttpError(status, message)` with `expose = true` | `utils/http-error.ts` |
| Response | `errorHandler`: status in 400–599 else 500; message only if `expose`; logs ≥ 500 | `middlewares/error.middleware.ts` |

Mapping:

| Code | Status |
|---|---|
| `UNSUPPORTED_IMAGE` | 415 |
| `IMAGE_UNREADABLE` | 422 |
| `DIMENSIONS_TOO_LARGE` | 422 (message includes the limit) |
| `NO_TEXT` | 422 |
| `BUSY` | 503 |
| `UNAVAILABLE` | 503 |
| `TIMEOUT` | 503 |
| `NotAadhaarCardError` | 422 |

`OcrAbortedError` never reaches the middleware: the controller swallows it.
Unknown errors become a logged 500 with a generic message, and the pipeline
wraps unexpected failures in `new Error("OCR recognition failed", { cause })`.
Upload and validation errors are already `HttpError`s, because they belong to
the HTTP boundary.

Why keep this split instead of one exception class? Services don't depend on
HTTP, the mapping lives in one type-checked table, and the `expose` flag stops
internal messages from leaking. I kept it during the alignment rather than
adopting a single application-exception class.

## 10. Worker-pool lifecycle

`services/ocr/ocr-worker-pool.ts`, driven by `OcrService` and `server.ts`:

1. **Lazy engines.** `workerCount` slots, each holding at most one engine,
   created on first use by `IOcrEngineFactory.create()`. A failed start isn't
   cached, so the next job on that slot retries.
2. **Bounded queue.** `run()` takes a free slot or waits for at most
   `queueTimeoutMs`. A waiter that times out, aborts or is cancelled by
   shutdown removes itself from the queue, so it is never handed a slot
   later. The slot is released only after the work settles.
3. **Discard and replace.** `EngineLease.discard()` terminates an engine that
   timed out or failed unexpectedly; the slot gets a fresh one next time.
4. **Readiness.** The status is `idle`, `starting`, `ready` or `failed`. A
   failed start is retried by a readiness check at most every 30 s
   (`READINESS_RETRY_MS`), and language-data failures are reported separately
   (`"language-data"`). `/api/ready` never runs recognition.
5. **Warm-up.** `server.ts` calls `warmUp()` after `listen` and logs whether
   an engine is ready.
6. **Shutdown.** `close()` rejects waiting jobs at once; `terminateAll()`
   terminates every engine. `server.ts` bounds the whole process with
   `SHUTDOWN_GRACE_MS = OCR_TIMEOUT_MS + 5_000`.

Why it matters: Tesseract workers are memory- and CPU-heavy and can hang.
Without bounds, a traffic spike or one pathological image could exhaust
memory, block every request, or leave orphaned workers after a deploy.

In production, `TesseractEngineFactory` verifies the language data's size and
SHA-256 against `language-data.json` before starting a worker, and reads it
read-only from `.tesseract-cache` (installed by `npm run fetch:lang-data` as
part of `npm run build`).

## 11. Patterns adapted from the restaurant-listing project

| Pattern | Adapted? | Where |
|---|---|---|
| `App` class with `setMiddleware` / `setRoutes` / `setErrorHandling` / `getApp` | Yes | `app.ts` |
| Route classes with `getRouter()` | Yes | `routes/ocr.routes.ts`, `routes/health.routes.ts` |
| Dependency container | Yes | `config/container.ts` |
| Controller classes with constructor-injected services | Yes | `controllers/` |
| `I`-prefixed interfaces in `services/interfaces/` | Yes | `services/interfaces/` |
| Plural folders and `.controllers.ts` / `.services.ts` suffixes | Yes | throughout |
| Repository layer | No | No persistence (section 8) |
| Single application-exception class | No | Kept `OcrError` codes and `HttpError` (section 9) |

## 12. Design trade-offs

- **Interfaces with one implementation.** Clear seams and narrow
  dependencies, at the cost of extra files and indirection that don't yet pay
  for themselves through substitution.
- **Thin `AadhaarParserService` wrapper.** An injectable parser while
  keeping the rules pure, at the cost of a class that only delegates.
- **`OcrService` facade.** One object behind four role interfaces is simple
  to wire, but it is the widest class.
- **Container built at import time.** Simple, and runs after env validation,
  but importing `config/container.ts` has side effects (it reads
  `language-data.json`), which makes it awkward to import in isolation.
- **Reserve before upload.** Protects memory under load, but a request is
  counted against capacity before its files are known to be valid. The
  reservation is released when the response closes.
- **`Promise.allSettled` for both sides.** Deterministic error attribution,
  at the cost of finishing the second side even when the first has failed.
- **Never-guess parsing.** Ambiguous fields become `null`, trading recall for
  correctness.

## 13. Verification status

- `npm run typecheck` and `npm run build` pass on the current working tree.
- **The backend has no permanent automated test suite.** There is no `test`
  script in `backend/package.json`, no test files, and none in the git
  history. `tsconfig.build.json` excludes `src/**/*.test.ts` and
  `src/test-utils`, but neither exists.
- During the refactor, behaviour was checked with temporary suites kept
  outside the repository: an HTTP regression suite and a startup test (for
  missing `language-data.json`), run against both the original commit and the
  refactored code, plus a parser-wrapper equivalence check. **Those suites
  were removed afterwards** and are not part of the project.
- The backend has no lint script.

## 14. Limitations

- **Every interface has exactly one production implementation.** No test
  doubles exist in the repository.
- **LSP is not demonstrated** for the interfaces by any existing
  verification; only signature compatibility is checked by the compiler.
- **DIP is partial:** routes, `App` and `OcrService` depend on concrete
  classes.
- **No permanent automated tests and no backend lint.** The first
  improvements I'd make are contract tests for `IOcrEngine` and
  `IAadhaarParser`, unit tests for `aadhaar-parser.rules.ts` using synthetic
  OCR results, and HTTP tests using a fake `IOcrEngineFactory`.
- **Known bug, not fixed:** a fractional `MAX_UPLOAD_SIZE_MB` (for example
  `2.5`) makes the server fail at startup.
- **Stale comment:** the doc comment on `IOcrEngine`
  (`services/interfaces/IOcrEngine.services.ts`) says "a fake in tests", but
  no tests exist in the repository.
- **Parser scope:** the rules expect the standard Aadhaar card layout; other
  layouts may produce `null` fields or `documentDetected: false`.
