import React from 'react';
import './SpeechBubble.css'; 
interface SpeechBubbleProps {
  variant?: 'user' | 'expected' | 'model';
  children: React.ReactNode;
}


const SpeechBubble: React.FC<SpeechBubbleProps> = ({ variant = 'user', children }) => {
  const validVariants = ['user', 'expected', 'model'] as const;

  if (!validVariants.includes(variant)) {
    console.warn(`Invalid variant '${variant}' provided to SpeechBubble.`);
  }
  
  return (
    <div className={`speech-bubble speech-bubble-${variant}`}>
      {children}
    </div>
  );
};

export default SpeechBubble;