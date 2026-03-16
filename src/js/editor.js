import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// ── Syntax highlighting (Cursor Dark palette) ──
const voltHighlightStyle = HighlightStyle.define([
  // Comments — muted gray, italic
  { tag: t.comment, color: '#6d6d6d', fontStyle: 'italic' },
  { tag: t.lineComment, color: '#6d6d6d', fontStyle: 'italic' },
  { tag: t.blockComment, color: '#6d6d6d', fontStyle: 'italic' },
  { tag: t.docComment, color: '#6d6d6d', fontStyle: 'italic' },

  // Strings — pink
  { tag: t.string, color: '#e394dc' },
  { tag: t.special(t.string), color: '#e394dc' },
  { tag: t.regexp, color: '#d6d6dd' },

  // Keywords — teal
  { tag: t.keyword, color: '#83d6c5' },
  { tag: t.controlKeyword, color: '#83d6c5' },
  { tag: t.operatorKeyword, color: '#83d6c5' },
  { tag: t.definitionKeyword, color: '#83d6c5' },
  { tag: t.moduleKeyword, color: '#83d6c5' },

  // Storage/modifiers — teal
  { tag: t.modifier, color: '#82d2ce' },
  { tag: t.annotation, color: '#a8cc7c' },

  // Functions — warm orange
  { tag: t.function(t.definition(t.variableName)), color: '#efb080', fontWeight: 'bold' },
  { tag: t.function(t.variableName), color: '#ebc88d' },

  // Variables — light gray
  { tag: t.variableName, color: '#d6d6dd' },
  { tag: t.definition(t.variableName), color: '#d6d6dd' },
  { tag: t.local(t.variableName), color: '#d6d6dd' },
  { tag: t.special(t.variableName), color: '#C1808A' }, // self/this

  // Properties — purple
  { tag: t.propertyName, color: '#AA9BF5' },
  { tag: t.definition(t.propertyName), color: '#AA9BF5' },

  // Types & classes — blue
  { tag: t.typeName, color: '#87c3ff' },
  { tag: t.className, color: '#87c3ff' },
  { tag: t.namespace, color: '#d1d1d1' },
  { tag: t.macroName, color: '#efb080' },

  // Numbers — warm yellow
  { tag: t.number, color: '#ebc88d' },
  { tag: t.integer, color: '#ebc88d' },
  { tag: t.float, color: '#ebc88d' },

  // Booleans & constants — teal
  { tag: t.bool, color: '#82d2ce' },
  { tag: t.null, color: '#82d2ce' },
  { tag: t.atom, color: '#82d2ce' },
  { tag: t.constant(t.variableName), color: '#83d6c5' },

  // Operators — light gray
  { tag: t.operator, color: '#d6d6dd' },
  { tag: t.compareOperator, color: '#d6d6dd' },
  { tag: t.logicOperator, color: '#d6d6dd' },
  { tag: t.arithmeticOperator, color: '#d6d6dd' },

  // Punctuation — light gray
  { tag: t.punctuation, color: '#d6d6dd' },
  { tag: t.paren, color: '#d6d6dd' },
  { tag: t.brace, color: '#d6d6dd' },
  { tag: t.squareBracket, color: '#d6d6dd' },
  { tag: t.separator, color: '#d6d6dd' },
  { tag: t.derefOperator, color: '#d6d6dd' },

  // HTML/XML tags — blue
  { tag: t.tagName, color: '#87c3ff' },
  { tag: t.attributeName, color: '#aaa0fa' },
  { tag: t.attributeValue, color: '#e394dc' },
  { tag: t.angleBracket, color: '#898989' },

  // CSS
  { tag: t.special(t.propertyName), color: '#87c3ff' }, // CSS property names
  { tag: t.color, color: '#ebc88d' },
  { tag: t.unit, color: '#ebc88d' },

  // Markdown
  { tag: t.heading, color: '#d6d6dd', fontWeight: 'bold' },
  { tag: t.emphasis, color: '#83d6c5', fontStyle: 'italic' },
  { tag: t.strong, color: '#f8c762', fontWeight: 'bold' },
  { tag: t.link, color: '#83d6c5' },
  { tag: t.url, color: '#83d6c5' },
  { tag: t.quote, color: '#6d6d6d' },

  // Meta/labels
  { tag: t.meta, color: '#aaa0fa' },
  { tag: t.labelName, color: '#efb080' },

  // Escape characters
  { tag: t.escape, color: '#d6d6dd' },

  // Invalid
  { tag: t.invalid, color: '#f44747' },
]);

// ── Editor chrome theme ──
const voltTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: '#141414',
    fontSize: '14px',
  },
  '.cm-content': {
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Menlo', 'Consolas', monospace",
    caretColor: '#b45dff',
    padding: '8px 0',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: '#b45dff',
    borderLeftWidth: '2px',
  },
  '.cm-gutters': {
    backgroundColor: '#141414',
    color: '#4a4a54',
    border: 'none',
    paddingLeft: '8px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: '#7a7a8a',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(180, 93, 255, 0.04)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(180, 93, 255, 0.18) !important',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'transparent',
    outline: '1px solid rgba(180, 93, 255, 0.25)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgba(240, 200, 0, 0.2)',
    outline: '1px solid rgba(240, 200, 0, 0.4)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgba(240, 200, 0, 0.35)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'rgba(180, 93, 255, 0.1)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: '#222222',
    border: 'none',
    color: '#7a7a8a',
  },
  '.cm-tooltip': {
    backgroundColor: '#1a1a1a',
    border: '1px solid #222222',
    color: '#d4d4d4',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'rgba(180, 93, 255, 0.12)',
  },
  '.cm-panels': {
    backgroundColor: '#161616',
    color: '#d4d4d4',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '.cm-scroller::-webkit-scrollbar': {
    width: '8px',
    height: '8px',
  },
  '.cm-scroller::-webkit-scrollbar-track': {
    background: 'transparent',
  },
  '.cm-scroller::-webkit-scrollbar-thumb': {
    background: '#3a3a44',
    borderRadius: '4px',
  },
}, { dark: true });

function fontSizeExtension(size) {
  return EditorView.theme({
    '.cm-content': { fontSize: `${size}px` },
    '.cm-gutters': { fontSize: `${size}px` },
  });
}

async function loadLanguage(lang) {
  try {
    switch (lang) {
      case 'javascript':
        return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
      case 'typescript':
        return (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true });
      case 'rust':
        return (await import('@codemirror/lang-rust')).rust();
      case 'python':
        return (await import('@codemirror/lang-python')).python();
      case 'html':
        return (await import('@codemirror/lang-html')).html();
      case 'css':
        return (await import('@codemirror/lang-css')).css();
      case 'json':
        return (await import('@codemirror/lang-json')).json();
      case 'yaml':
        return (await import('@codemirror/lang-yaml')).yaml();
      case 'markdown':
        return (await import('@codemirror/lang-markdown')).markdown();
      case 'dart': {
        const { StreamLanguage } = await import('@codemirror/language');
        const { dart } = await import('@codemirror/legacy-modes/mode/clike');
        return StreamLanguage.define(dart);
      }
      case 'toml': {
        const { StreamLanguage } = await import('@codemirror/language');
        const { toml } = await import('@codemirror/legacy-modes/mode/toml');
        return StreamLanguage.define(toml);
      }
      case 'shell': {
        const { StreamLanguage } = await import('@codemirror/language');
        const { shell } = await import('@codemirror/legacy-modes/mode/shell');
        return StreamLanguage.define(shell);
      }
      case 'go': {
        const { StreamLanguage } = await import('@codemirror/language');
        const { go } = await import('@codemirror/legacy-modes/mode/go');
        return StreamLanguage.define(go);
      }
      case 'c': {
        const { StreamLanguage } = await import('@codemirror/language');
        const { c } = await import('@codemirror/legacy-modes/mode/clike');
        return StreamLanguage.define(c);
      }
      case 'cpp': {
        const { StreamLanguage } = await import('@codemirror/language');
        const { cpp } = await import('@codemirror/legacy-modes/mode/clike');
        return StreamLanguage.define(cpp);
      }
      case 'java': {
        const { StreamLanguage } = await import('@codemirror/language');
        const { java } = await import('@codemirror/legacy-modes/mode/clike');
        return StreamLanguage.define(java);
      }
      default:
        return [];
    }
  } catch (e) {
    console.warn(`Failed to load language: ${lang}`, e);
    return [];
  }
}

export async function createEditorView(content, language, wrapper, fontSize, onModified, onCursorChange, onDocChange) {
  let originalContent = content;
  let wasModified = false;

  const fontComp = new Compartment();
  const langComp = new Compartment();

  const langExt = await loadLanguage(language);

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      // Fast path: if lengths differ, it's definitely modified (O(1) check).
      // Only do expensive full-content comparison when lengths match.
      const docLen = update.state.doc.length;
      const isModified = docLen !== originalContent.length
        || update.state.doc.toString() !== originalContent;
      if (isModified !== wasModified) {
        wasModified = isModified;
        onModified(isModified);
      }
    }
    if (update.docChanged && onDocChange) {
      onDocChange();
    }
    if (onCursorChange && (update.selectionSet || update.docChanged)) {
      const pos = update.state.selection.main.head;
      const line = update.state.doc.lineAt(pos);
      onCursorChange(line.number, pos - line.from + 1);
    }
  });

  // Intercept Ctrl+S so it doesn't insert into the document
  const preventCtrlS = keymap.of([{
    key: 'Mod-s',
    run: () => true,
  }]);

  const state = EditorState.create({
    doc: content,
    extensions: [
      basicSetup,
      keymap.of([indentWithTab]),
      preventCtrlS,
      voltTheme,
      syntaxHighlighting(voltHighlightStyle),
      fontComp.of(fontSizeExtension(fontSize)),
      langComp.of(langExt),
      EditorView.lineWrapping,
      updateListener,
    ],
  });

  const view = new EditorView({ state, parent: wrapper });

  // Attach per-view references
  view._voltOriginal = { get: () => originalContent, set: (v) => { originalContent = v; wasModified = false; } };
  view._voltFontComp = fontComp;

  return view;
}

export function getEditorContent(view) {
  return view.state.doc.toString();
}

export function markClean(view) {
  if (view._voltOriginal) {
    view._voltOriginal.set(view.state.doc.toString());
  }
}

export function replaceEditorContent(view, newContent) {
  const cursor = view.state.selection.main.head;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: newContent },
    selection: { anchor: Math.min(cursor, newContent.length) },
  });
  // Update original content so it's not marked as modified
  if (view._voltOriginal) {
    view._voltOriginal.set(newContent);
  }
}

export function goToLine(view, line) {
  const lineNum = Math.min(line, view.state.doc.lines);
  const lineInfo = view.state.doc.line(lineNum);
  view.dispatch({
    selection: { anchor: lineInfo.from },
    scrollIntoView: true,
  });
  view.focus();
}

export function setEditorFontSize(view, size) {
  if (view._voltFontComp) {
    view.dispatch({
      effects: view._voltFontComp.reconfigure(fontSizeExtension(size)),
    });
  }
}

