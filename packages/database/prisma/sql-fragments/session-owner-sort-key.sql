-- The OWNER DISPLAY-NAME sort key, case-folded — `"First Last"` with empty
-- name parts dropped, trimmed, falling back to email when no part survives.
--
-- `btrim` with an explicit set, not bare `trim(x)`: that is `btrim(x, ' ')` and
-- strips SPACES ONLY, while JS `.trim()` also strips tab, the line terminators,
-- NBSP and the rest of the Unicode space separators. The set is exactly
-- ECMAScript's `TrimString` whitespace — the 25 BMP code points
-- `String.prototype.trim` removes.
--
-- COLLATION IS THE CALLER'S, and every caller must supply one: the comparators
-- this key is held against use a plain `<` on code units, so each splice site
-- applies `COLLATE "C"` to the expression it embeds this in. Carrying it here
-- instead would conflict with the sibling branches of the compound statement's
-- text CASE, which collate implicitly.
lower(
  COALESCE(
    NULLIF(
      btrim(
        concat_ws(' ', NULLIF(u.first_name, ''), NULLIF(u.last_name, '')),
        E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'
      ),
      ''
    ),
    u.email
  )
)
