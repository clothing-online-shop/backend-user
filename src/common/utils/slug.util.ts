import slugify from 'slugify';

const COMBINING_DIACRITICS = new RegExp('[̀-ͯ]', 'g');

export function generateSlug(input: string): string {
  const withoutDiacritics = input
    .normalize('NFD')
    .replace(COMBINING_DIACRITICS, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');

  return slugify(withoutDiacritics, { lower: true, strict: true, trim: true });
}
