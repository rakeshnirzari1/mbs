const DEFAULT_API_BASE_URL = 'https://mbsr_api_services.health.gov.au/v1/mbsitems';
const CURRENCY_FORMATTER = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD'
});

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

function parseAmount(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.replace(/[^0-9.-]/g, '');
    if (!normalized) {
      return null;
    }

    const parsed = Number.parseFloat(normalized);
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
    itemDescription: firstNonEmpty(
      item?.item_description,
      item?.itemDescription,
      item?.description,
      item?.definition,
      stripMarkup(item?.text?.div)
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

export function formatAmount(amount) {
  return amount === null ? 'not available' : CURRENCY_FORMATTER.format(amount);
}

export function buildAnswer(item, focus = 'both') {
  const title = item.itemDescription ?? item.itemName ?? 'MBS item';

  if (focus === 'fee') {
    return `MBS item ${item.itemNumber} (${title}) has a scheduled fee of ${formatAmount(item.fee)}.`;
  }

  if (focus === 'rebate') {
    return `MBS item ${item.itemNumber} (${title}) has a Medicare rebate of ${formatAmount(item.rebate)}.`;
  }

  return `MBS item ${item.itemNumber} (${title}) has a scheduled fee of ${formatAmount(item.fee)} and a Medicare rebate of ${formatAmount(item.rebate)}.`;
}

export async function lookupMbsItem(itemNumber, options = {}) {
  const normalizedItemNumber = normalizeItemNumber(itemNumber);
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl = options.apiBaseUrl ?? process.env.MBS_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  const timeoutMs = options.timeoutMs ?? Number.parseInt(process.env.MBS_API_TIMEOUT_MS ?? '15000', 10);
  const url = new URL(apiBaseUrl);
  url.searchParams.set('item', normalizedItemNumber);

  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json'
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`The MBS API request failed with status ${response.status}.`);
  }

  const payload = await response.json();
  const item = findMatchingItem(payload, normalizedItemNumber);

  if (!item) {
    throw new Error(`No MBS item was found for item number ${normalizedItemNumber}.`);
  }

  return mapItem(item, normalizedItemNumber);
}
