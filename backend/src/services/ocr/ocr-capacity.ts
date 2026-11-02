import { OcrError } from "./ocr.errors";

export class OcrCapacity {
  #jobsInFlight = 0;
  #closed = false;

  constructor(private readonly maxJobs: number) {}

  get isClosed(): boolean {
    return this.#closed;
  }

  reserve(jobs: number): OcrReservation {
    if (this.#closed) throw new OcrError("UNAVAILABLE");
    if (this.#jobsInFlight + jobs > this.maxJobs) throw new OcrError("BUSY");
    this.#jobsInFlight += jobs;
    return new OcrReservation(this, jobs);
  }

  startJob(reservation: OcrReservation): void {
    if (!(reservation instanceof OcrReservation) || !reservation.take(this)) {
      throw new Error("OCR reservation has no capacity left");
    }
  }

  finishJob(): void {
    this.#jobsInFlight -= 1;
  }

  returnUnused(units: number): void {
    this.#jobsInFlight -= units;
  }

  close(): void {
    this.#closed = true;
  }
}

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

  release(): void {
    this.#capacity.returnUnused(this.#remaining);
    this.#remaining = 0;
  }
}
