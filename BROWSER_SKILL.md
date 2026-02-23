---
name: Browser Tool Usage
description: Correct usage patterns for the OpenClaw browser tool
tags: [browser, automation, web]
---

# Browser Tool Usage Guide

## Top-Level Actions (use `action` parameter)

These are **direct actions**, not act kinds:

- `action: "focus"` - Focus a specific tab
- `action: "close"` - Close a tab  
- `action: "navigate"` - Navigate to URL
- `action: "open"` - Open new tab
- `action: "tabs"` - List all tabs
- `action: "snapshot"` - Get page content
- `action: "screenshot"` - Take screenshot
- `action: "status"` - Check browser status

### Examples:

```json
// ✅ CORRECT - Focus a tab
{
  "action": "focus",
  "targetId": "ABC123..."
}

// ✅ CORRECT - Close a tab
{
  "action": "close",
  "targetId": "ABC123..."
}

// ❌ WRONG - Don't use act for focus
{
  "action": "act",
  "request": {
    "kind": "focus",  // ❌ Invalid!
    "targetId": "..."
  }
}
```

## Act Kinds (use `action: "act"` with `request.kind`)

Use `action: "act"` **only** for UI interactions on the page:

Valid act kinds: `click`, `type`, `press`, `hover`, `drag`, `select`, `fill`, `resize`, `wait`, `evaluate`, `close`

### Examples:

```json
// ✅ CORRECT - Click element
{
  "action": "act",
  "request": {
    "kind": "click",
    "ref": "e12"
  }
}

// ✅ CORRECT - Type text
{
  "action": "act",
  "request": {
    "kind": "type",
    "ref": "e5",
    "text": "Hello world"
  }
}
```

## Common Patterns

**List tabs:**
```json
{ "action": "tabs" }
```

**Focus tab 1 (first tab):**
```json
{
  "action": "focus",
  "targetId": "<id-from-tabs-list>"
}
```

**Navigate:**
```json
{
  "action": "navigate",
  "targetUrl": "https://example.com"
}
```

**Get page snapshot:**
```json
{ "action": "snapshot" }
```

**Click element:**
```json
{
  "action": "act",
  "request": {
    "kind": "click",
    "ref": "e12"
  }
}
```
