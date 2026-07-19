const DEFAULT_API_BASE_URL = 'https://www9.health.gov.au/mbs/fullDisplay.cfm';
const CURRENCY_FORMATTER = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD'
});
export const DECIMAL_AMOUNT_PATTERN_SOURCE = '[0-9][0-9,]*(?:\\.[0-9]+)?';
const CURRENCY_AMOUNT_PATTERN = new RegExp(`\\$\\s*(${DECIMAL_AMOUNT_PATTERN_SOURCE})`);
const STRICT_DECIMAL_AMOUNT_PATTERN = new RegExp(`^${DECIMAL_AMOUNT_PATTERN_SOURCE}$`);
const BENEFIT_PERCENTAGE_AMOUNT_PATTERN = new RegExp(
  `(\\d{1,3})%\\s*=\\s*\\$?\\s*(${DECIMAL_AMOUNT_PATTERN_SOURCE})`,
  'gi'
);

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return null;
}

function stripMarkup(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized || null;
}

export function isMetadataDescription(value) {
  if (typeof value !== 'string') {
    return false;
  }

  return /^updated\s*:\s*\d{1,2}[-/][A-Za-z0-9]{3,}[-/]\d{2,4}$/i.test(value.trim());
}

export function parseCurrencyAmountText(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.match(CURRENCY_AMOUNT_PATTERN);
  if (!match?.[1]) {
    return null;
  }

  const parsed = Number.parseFloat(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeDescription(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (!normalized || isMetadataDescription(normalized)) {
    return null;
  }

  return normalized;
}

function parseAmount(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    const parsedCurrency = parseCurrencyAmountText(normalized);
    if (parsedCurrency !== null) {
      return parsedCurrency;
    }

    if (/%/.test(normalized)) {
      return null;
    }

    if (!STRICT_DECIMAL_AMOUNT_PATTERN.test(normalized)) {
      return null;
    }

    const parsed = Number.parseFloat(normalized.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function normalizeItemNumber(itemNumber) {
  const normalized = String(itemNumber ?? '').trim().replace(/\s+/g, '');

  if (!normalized) {
    throw new Error('An MBS item number is required.');
  }

  if (!/^[0-9A-Za-z]+$/.test(normalized)) {
    throw new Error('MBS item numbers must be alphanumeric.');
  }

  return normalized.toUpperCase();
}

function getItemCode(item) {
  return firstNonEmpty(
    item?.item_number,
    item?.itemNumber,
    item?.code,
    item?.code?.coding?.[0]?.code,
    item?.code?.text
  );
}

function findMatchingItem(payload, itemNumber) {
  const directItem = Array.isArray(payload?.mbs_items)
    ? payload.mbs_items
    : Array.isArray(payload?.items)
      ? payload.items
      : null;

  if (directItem) {
    return directItem.find((item) => String(getItemCode(item)).toUpperCase() === itemNumber) ?? null;
  }

  if (Array.isArray(payload?.entry)) {
    return payload.entry
      .map((entry) => entry?.resource ?? entry)
      .find((item) => String(getItemCode(item)).toUpperCase() === itemNumber) ?? null;
  }

  if (payload && typeof payload === 'object' && String(getItemCode(payload)).toUpperCase() === itemNumber) {
    return payload;
  }

  return null;
}

function mapItem(item, itemNumber) {
  return {
    itemNumber,
    itemName: firstNonEmpty(item?.item_name, item?.itemName, item?.name, item?.display, item?.code?.text),
    itemDescription: sanitizeDescription(
      firstNonEmpty(
        item?.item_description,
        item?.itemDescription,
        item?.description,
        item?.definition,
        stripMarkup(item?.text?.div)
      )
    ),
    fee: parseAmount(firstNonEmpty(item?.fee, item?.schedule_fee, item?.scheduleFee, item?.scheduleFeeAmount)),
    rebate: parseAmount(
      firstNonEmpty(
        item?.rebate,
        item?.benefit,
        item?.benefit_amount,
        item?.benefitAmount,
        item?.medicare_benefit
      )
    ),
    effectiveFrom: firstNonEmpty(item?.effective_from, item?.effectiveFrom, item?.dateStart),
    effectiveTo: firstNonEmpty(item?.effective_to, item?.effectiveTo, item?.dateEnd)
  };
}

function extractHtmlField(html, label, stopLabels = []) {
  const plainText = stripMarkup(html);
  if (!plainText) {
    return null;
  }

  const labelPattern = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stopPattern = stopLabels.length
    ? `(?=${stopLabels.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}|$)`
    : '$';
  const match = plainText.match(new RegExp(`${labelPattern}\\s*:?[\\s-]*(.*?)${stopPattern}`, 'i'));

  return match?.[1]?.trim() || null;
}

function extractBenefitAmount(benefitText) {
  if (!benefitText) {
    return null;
  }

  const percentageMatches = Array.from(benefitText.matchAll(BENEFIT_PERCENTAGE_AMOUNT_PATTERN)).map((match) => ({
    percentage: Number.parseInt(match[1], 10),
    amount: Number.parseFloat(match[2].replace(/,/g, ''))
  }));

  if (percentageMatches.length > 0) {
    const preferredPercentages = [100, 85, 75];
    for (const preferredPercentage of preferredPercentages) {
      const preferredMatch = percentageMatches.find((match) => match.percentage === preferredPercentage);
      if (Number.isFinite(preferredMatch?.amount)) {
        return preferredMatch.amount;
      }
    }

    return percentageMatches.sort((a, b) => b.percentage - a.percentage)[0]?.amount ?? null;
  }

  return parseCurrencyAmountText(benefitText);
}

function extractFirstMatchingHtmlField(html, labels, stopLabels = []) {
  for (const label of labels) {
    const value = extractHtmlField(html, label, stopLabels);
    if (value) {
      return value;
    }
  }

  return null;
}

function mapHtmlItem(itemNumber, html) {
  const description = extractFirstMatchingHtmlField(
    html,
    ['Description', 'Descriptor'],
    ['Schedule Fee', 'Benefit', 'Benefits', 'Extended Medicare Safety Net Cap']
  );
  const feeText = extractFirstMatchingHtmlField(
    html,
    ['Schedule Fee', 'Fee'],
    ['Benefit', 'Benefits', 'Extended Medicare Safety Net Cap']
  );
  const benefitText = extractFirstMatchingHtmlField(
    html,
    ['Benefit', 'Benefits', 'Medicare Benefit'],
    ['Extended Medicare Safety Net Cap', 'Derived Fee']
  );

  return {
    itemNumber,
    itemName: null,
    itemDescription: sanitizeDescription(description),
    fee: parseAmount(feeText),
    rebate: parseAmount(extractBenefitAmount(benefitText)),
    effectiveFrom: null,
    effectiveTo: null
  };
}

function buildLookupUrl(apiBaseUrl, itemNumber) {
  const url = new URL(apiBaseUrl);

  if (url.pathname.endsWith('fullDisplay.cfm')) {
    url.searchParams.set('type', 'item');
    url.searchParams.set('q', itemNumber);
  } else {
    url.searchParams.set('item', itemNumber);
  }

  return url;
}

export function formatAmount(amount) {
  return amount === null ? 'not available' : CURRENCY_FORMATTER.format(amount);
}

export function buildAnswer(item, focus = 'both') {
  const descriptor = item.itemDescription ?? item.itemName;
  const prefix = descriptor ? `MBS item ${item.itemNumber} (${descriptor})` : `MBS item ${item.itemNumber}`;

  if (focus === 'fee') {
    return `${prefix} has a scheduled fee of ${formatAmount(item.fee)}.`;
  }

  if (focus === 'rebate') {
    return `${prefix} has a Medicare rebate of ${formatAmount(item.rebate)}.`;
  }

  return `${prefix} has a scheduled fee of ${formatAmount(item.fee)} and a Medicare rebate of ${formatAmount(item.rebate)}.`;
}

export async function lookupMbsItem(itemNumber, options = {}) {
  const normalizedItemNumber = normalizeItemNumber(itemNumber);
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl = options.apiBaseUrl ?? process.env.MBS_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  const timeoutMs = options.timeoutMs ?? Number.parseInt(process.env.MBS_API_TIMEOUT_MS ?? '15000', 10);
  const response = await fetchImpl(buildLookupUrl(apiBaseUrl, normalizedItemNumber), {
    headers: {
      accept: 'application/json, text/html;q=0.9'
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`The MBS lookup request failed with status ${response.status}.`);
  }

  const contentType = response.headers?.get?.('content-type') ?? '';

  if (contentType.includes('json')) {
    const payload = await response.json();
    const item = findMatchingItem(payload, normalizedItemNumber);

    if (!item) {
      throw new Error(`No MBS item was found for item number ${normalizedItemNumber}.`);
    }

    return mapItem(item, normalizedItemNumber);
  }

  const html = await response.text();
  const item = mapHtmlItem(normalizedItemNumber, html);

  // Some official pages (for example incentive-style items) can expose description text
  // even when fee/rebate rows are omitted or formatted inconsistently.
  if (item.fee === null && item.rebate === null && item.itemDescription === null) {
    throw new Error(`No MBS item was found for item number ${normalizedItemNumber}.`);
  }

  return item;
}
