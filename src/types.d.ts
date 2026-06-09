declare module 'pdf-parse' {
  interface PDFData {
    text: string
    numpages: number
    info: Record<string, unknown>
    metadata: unknown
  }
  function pdfParse(buffer: Buffer, options?: Record<string, unknown>): Promise<PDFData>
  export = pdfParse
}
