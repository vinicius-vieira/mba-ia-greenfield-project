/** The storage refused to assemble a multipart upload from the given parts. */
export class InvalidMultipartPartsError extends Error {
  constructor(public readonly storageCode: string) {
    super(`Storage rejected the multipart part list (${storageCode})`);
    this.name = InvalidMultipartPartsError.name;
  }
}
