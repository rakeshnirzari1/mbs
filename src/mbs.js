const DEFAULT_API_BASE_URL = 'https://www9.health.gov.au/mbs/fullDisplay.cfm';
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

  const percentageMatches = Array.from(
    benefitText.matchAll(/(\d{1,3})%\s*=\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/gi)
  ).map((match) => ({
    percentage: Number.parseInt(match[1], 10),
    amount: match[2]
  }));

  if (percentageMatches.length > 0) {
    const preferredPercentages = [100, 85, 75];
    for (const preferredPercentage of preferredPercentages) {
      const preferredMatch = percentageMatches.find((match) => match.percentage === preferredPercentage);
      if (preferredMatch?.amount) {
        return preferredMatch.amount;
      }
    }

    return percentageMatches.sort((a, b) => b.percentage - a.percentage)[0].amount;
  }

  const firstAmount = benefitText.match(/([0-9][0-9,]*(?:\.[0-9]+)?)/);
  return firstAmount?.[1]?.trim() ?? null;
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
    itemDescription: description,
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

  if (item.fee === null && item.rebate === null && item.itemDescription === null) {
    throw new Error(`No MBS item was found for item number ${normalizedItemNumber}.`);
  }

  return item;
}
