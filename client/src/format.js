export const formatPages = ({ pageStart, pageEnd }) =>
  pageStart === pageEnd ? `p. ${pageStart}` : `pp. ${pageStart}–${pageEnd}`

export function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const formatNumber = (n = 0) => n.toLocaleString('en-IN')
