export function encodeBase64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function decodeBase64Url(input) {
  let value = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = value.length % 4;
  if (pad) value += '='.repeat(4 - pad);
  return Buffer.from(value, 'base64');
}
