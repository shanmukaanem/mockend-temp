import { MAX_CONFIG_BYTES } from './config.mjs'

const encoder = new TextEncoder()

/**
 * Turn JSON leaf fields into typed equality conditions using escaped JSON pointers.
 * Reject invalid, fieldless, or oversized examples before modifying a rule.
 * @param {string} text Example request JSON.
 * @returns {{source: 'body', key: string, value: unknown}[]} At most 30 AND conditions.
 */
export function parametersFromExample(text) {
  if (encoder.encode(text).length > MAX_CONFIG_BYTES) throw new Error('The example exceeds 4 MiB.')
  const value = JSON.parse(text)
  if (!value || typeof value !== 'object') throw new Error('Use a JSON object or array with fields.')
  const result = []
  const queue = [['', value]]
  for (const [path, item] of queue) {
    const children = item && typeof item === 'object' ? Object.entries(item) : []
    if (path && !children.length) {
      result.push({ source: 'body', key: path, value: item })
      if (result.length > 30) throw new Error('Generate at most 30 matching conditions.')
    } else for (const [key, child] of children) {
      queue.push([`${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, child])
    }
  }
  if (!result.length) throw new Error('Use a JSON object or array with fields.')
  return result
}
