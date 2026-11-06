/**
 * A model's natural-language reply, as a speech bubble.
 *
 * Replies are written in markdown, so they are rendered as markdown rather
 * than shown with their asterisks and backticks. Long replies are clamped to
 * a few lines with a "Show more" toggle: unclamped, one case's reply could
 * fill the screen and push every other case out of view.
 */

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Button } from './ui';

import SpeechBubble from './SpeechBubble';

/** Replies longer than this (or with more lines) start out clamped. */
const CLAMP_CHARS = 260;
const CLAMP_LINES = 5;
const CLAMPED_HEIGHT = 118;

const ReplyBubble: React.FC<{
  text: string;
  variant?: 'user' | 'expected' | 'model';
}> = ({ text, variant = 'model' }) => {
  const [open, setOpen] = useState(false);
  const long = text.length > CLAMP_CHARS || text.split('\n').length > CLAMP_LINES;
  const clamped = long && !open;

  return (
    <div>
      <SpeechBubble variant={variant}>
        <div
          className="reply-markdown"
          style={
            clamped
              ? {
                  maxHeight: CLAMPED_HEIGHT,
                  overflow: 'hidden',
                  WebkitMaskImage: 'linear-gradient(to bottom, #000 70%, transparent)',
                  maskImage: 'linear-gradient(to bottom, #000 70%, transparent)',
                }
              : undefined
          }
        >
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      </SpeechBubble>
      {long && (
        <Button
          type="link"
          size="small"
          style={{ padding: 0, fontSize: 12, height: 22 }}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show Less' : 'Show More'}
        </Button>
      )}
    </div>
  );
};

export default ReplyBubble;
