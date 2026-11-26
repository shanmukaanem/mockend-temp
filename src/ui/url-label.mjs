/** Display API origins without their scheme; keep full URLs for matching and editing. */
export function baseUrlLabel(value) {
  return value.replace(/https?:\/\//gi, '')
}
