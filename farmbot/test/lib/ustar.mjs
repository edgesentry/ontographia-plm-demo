// A minimal ustar writer for tests.
//
// The release-asset tests need tar archives with member names and entry types
// that a normal `tar -czf` refuses to create (an absolute name, a `..` member,
// a hardlink). Writing the headers here keeps the test independent of the
// local tar implementation's flags: GNU tar and bsdtar both read these bytes.
//
// Only the subset the tests need is implemented: regular files, directories,
// symlinks, hardlinks and FIFOs, each with a name shorter than 100 bytes and no
// ustar `prefix`.

import { gzipSync } from 'node:zlib';

const BLOCK = 512;

function octal(value, width) {
  const text = Math.trunc(value).toString(8);
  if (text.length > width - 1) throw new Error(`octal field overflow: ${value}`);
  return `${text.padStart(width - 1, '0')}\0`;
}

function header({ name, mode, size, type, linkname }) {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(mode, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(size, 12), 124, 'ascii');
  block.write(octal(0, 12), 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(type, 156, 'ascii');
  block.write(linkname ?? '', 157, 100, 'utf8');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  block.write(octal(0, 8), 329, 'ascii');
  block.write(octal(0, 8), 337, 'ascii');

  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');

  const padding = Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
  return { block, padding };
}

/**
 * Build a gzipped tar archive in memory.
 *
 * @param {Array<{ name: string, type?: 'file'|'dir'|'symlink'|'hardlink'|'fifo',
 *   data?: string, linkname?: string, mode?: number }>} entries
 * @returns {Buffer}
 */
export function createTarGz(entries) {
  const parts = [];
  for (const entry of entries) {
    const type = entry.type ?? 'file';
    let typeflag;
    let data = Buffer.alloc(0);
    let mode = entry.mode;
    if (type === 'file') {
      typeflag = '0';
      data = Buffer.from(entry.data ?? '', 'utf8');
      mode ??= 0o644;
    } else if (type === 'dir') {
      typeflag = '5';
      mode ??= 0o755;
    } else if (type === 'symlink') {
      typeflag = '2';
      mode ??= 0o777;
    } else if (type === 'hardlink') {
      typeflag = '1';
      mode ??= 0o644;
    } else if (type === 'fifo') {
      typeflag = '6';
      mode ??= 0o644;
    } else {
      throw new Error(`unknown tar entry type ${type}`);
    }
    const { block, padding } = header({
      name: entry.name,
      mode,
      size: data.length,
      type: typeflag,
      linkname: entry.linkname,
    });
    parts.push(block, data, padding);
  }
  parts.push(Buffer.alloc(BLOCK), Buffer.alloc(BLOCK));
  return gzipSync(Buffer.concat(parts));
}
