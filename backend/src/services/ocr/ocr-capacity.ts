import { OcrError } from "./ocr.errors";

// Admission control: counts OCR jobs that are reserved, waiting or running,
// and never lets that number exceed `maxJobs`.
export class OcrCapacity {
  #jobsInFlight = 0;
  #closed = false;

  constructor(private readonly maxJobs: number) {}

  get isClosed(): boolean {
    return this.#closed;
  }

  /**
   * Reserves capacity for `jobs` images before an upload is buffered. The
   * check and the increment happen synchronously, so concurrent requests
   * can't all pass the check.
   */
  reserve(jobs: number): OcrReservation {
    if (this.#closed) throw new OcrError("UNAVAILABLE");
    if (this.#jobsInFlight + jobs > this.maxJobs) throw new OcrError("BUSY");
    this.#jobsInFlight += jobs;
    return new OcrReservation(this, jobs);
  }

  /** Turns one reserved unit into a running job. */
  startJob(reservation: OcrReservation): void {
    if (!(reservation instanceof OcrReservation) || !reservation.take(this)) {
      throw new Error("OCR reservation has no capacity left");
    }
  }

  /** A job that started has finished, however it ended. */
  finishJob(): void {
    this.#jobsInFlight -= 1;
  }

  /** Hands back units a reservation never used. Called by OcrReservation. */
  returnUnused(units: number): void {
    this.#jobsInFlight -= units;
  }

  close(): void {
    this.#closed = true;
  }
}

// Capacity taken before a request's upload is read. Each job converts one
// unit; release() hands back whatever no job used. Only OcrCapacity.reserve()
// creates these; the private fields make the type nominal, so look-alike
// objects can't be passed in its place.
export class OcrReservation {
  readonly #capacity: OcrCapacity;
  #remaining: number;

  constructor(capacity: OcrCapacity, jobs: number) {
    this.#capacity = capacity;
    this.#remaining = jobs;
  }

  take(capacity: OcrCapacity): boolean {
    if (capacity !== this.#capacity || this.#remaining === 0) return false;
    this.#remaining -= 1;
    return true;
  }

  /** Returns capacity no job has used yet. Safe to call more than once. */
  release(): void {
    this.#capacity.returnUnused(this.#remaining);
    this.#remaining = 0;
  }
}
