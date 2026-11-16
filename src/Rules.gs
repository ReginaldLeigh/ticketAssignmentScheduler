/**
 * Rules.gs — mailbox routing rules.
 * A rule is a list of conditions that must ALL match (AND). A mailbox can have several rules (OR).
 * Mailboxes are checked in priority order (lowest number first) and the first match wins.
 */
const RULE_OPERATORS = {
  equals: 'equals', not_equals: 'does not equal', contains: 'contains', starts_with: 'starts with',
  in: 'is one of', between: 'is between', gt: 'is greater than', lt: 'is less than',
  regex: 'matches pattern', is_empty: 'is empty',
};

const Rules = {
  /** Throws ValidationError if the conditions are not valid. Returns normalized conditions. */
  validate(conditions) {
    if (!Array.isArray(conditions) || !conditions.length) throw new ValidationError('A rule needs at least one condition.');
    if (conditions.length > 20) throw new ValidationError('A rule can have at most 20 conditions.');
    return conditions.map((c, i) => {
      const n = i + 1;
      const field = String((c && c.field) || '').trim();
      const op = String((c && c.op) || '').trim();
      if (!field) throw new ValidationError('Condition ' + n + ': choose a field.');
      if (!/^[A-Za-z0-9_]+$/.test(field)) throw new ValidationError('Condition ' + n + ': invalid field name.');
      if (!RULE_OPERATORS[op]) throw new ValidationError('Condition ' + n + ': unknown operator.');
      let value = c.value;
      if (op === 'is_empty') value = null;
      else if (op === 'between') {
        if (!Array.isArray(value) || value.length !== 2 || value.some((v) => v === '' || v === null || isNaN(Number(v)))) {
          throw new ValidationError('Condition ' + n + ': "is between" needs two numbers.');
        }
        value = [Number(value[0]), Number(value[1])].sort((a, b) => a - b);
      } else if (op === 'gt' || op === 'lt') {
        if (value === '' || value === null || isNaN(Number(value))) throw new ValidationError('Condition ' + n + ': enter a number.');
        value = Number(value);
      } else if (op === 'in') {
        const list = Array.isArray(value) ? value : String(value || '').split(',');
        value = list.map((v) => String(v).trim()).filter(Boolean);
        if (!value.length) throw new ValidationError('Condition ' + n + ': enter at least one value.');
      } else if (op === 'regex') {
        value = String(value || '');
        if (!value) throw new ValidationError('Condition ' + n + ': enter a pattern.');
        if (value.length > 200) throw new ValidationError('Condition ' + n + ': pattern is too long.');
        try { new RegExp(value, 'i'); } catch (e) { throw new ValidationError('Condition ' + n + ': invalid pattern.'); }
      } else {
        value = String(value === null || value === undefined ? '' : value).trim();
        if (!value) throw new ValidationError('Condition ' + n + ': enter a value.');
      }
      return { field: field, op: op, value: value };
    });
  },

  fieldValue_(ticket, field) {
    const f = ticket.fields || {};
    if (field in f) return f[field];
    const lower = field.toLowerCase();
    const key = Object.keys(f).find((k) => k.toLowerCase() === lower);
    return key ? f[key] : undefined;
  },

  evaluateCondition(c, ticket) {
    const raw = Rules.fieldValue_(ticket, c.field);
    const s = raw === null || raw === undefined ? '' : String(raw).trim();
    const sl = s.toLowerCase();
    const num = s === '' ? NaN : Number(s);
    switch (c.op) {
      case 'is_empty': return s === '';
      case 'equals': return (!isNaN(num) && !isNaN(Number(c.value))) ? num === Number(c.value) : sl === String(c.value).toLowerCase();
      case 'not_equals': return (!isNaN(num) && !isNaN(Number(c.value))) ? num !== Number(c.value) : sl !== String(c.value).toLowerCase();
      case 'contains': return sl.indexOf(String(c.value).toLowerCase()) !== -1;
      case 'starts_with': return sl.indexOf(String(c.value).toLowerCase()) === 0;
      case 'in': return c.value.some((v) => String(v).toLowerCase() === sl);
      case 'between': return !isNaN(num) && num >= c.value[0] && num <= c.value[1];
      case 'gt': return !isNaN(num) && num > Number(c.value);
      case 'lt': return !isNaN(num) && num < Number(c.value);
      case 'regex': try { return new RegExp(c.value, 'i').test(s); } catch (e) { return false; }
      default: return false;
    }
  },

  matches(conditions, ticket) {
    return Array.isArray(conditions) && conditions.length > 0 && conditions.every((c) => Rules.evaluateCondition(c, ticket));
  },

  /** First matching mailbox in priority order: { mailboxId, ruleId, ruleVersion } or null. */
  route(ticket, snapshot) {
    for (let i = 0; i < snapshot.mailboxes.length; i++) {
      const mb = snapshot.mailboxes[i];
      const rules = snapshot.rules.filter((r) => r.mailbox_id === mb.id);
      for (let j = 0; j < rules.length; j++) {
        if (Rules.matches(rules[j].conditions_json, ticket)) {
          return { mailboxId: mb.id, ruleId: rules[j].id, ruleVersion: rules[j].version };
        }
      }
    }
    return null;
  },
};
