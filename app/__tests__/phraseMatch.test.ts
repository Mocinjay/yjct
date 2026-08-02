import { matchesWakePhrase } from '../src/wakeword/phraseMatch';

describe('matchesWakePhrase', () => {
  it.each([
    // bare / cased / punctuated
    'clipso',
    'Clipso!',
    'CLIPSO',
    'clipsoh',
    'clipso…',
    "clipso's",
    // in a sentence
    'yo clipso',
    'hey clipso',
    'okay clipso',
    'and then I said clipso that was crazy',
    'wait clipso please save that',
    'yo clipso, clip that',
    // ASR splits the unknown brand name
    'clip so',
    'clips o',
    'clip s o',
    'clips oh',
    'clipse oh',
    'clipse o',
    'clip uh so',
    'klipso',
    'clipzo',
    'clipsaw',
    'clip show',
    'calypso',
    // action alternate
    'okay clip that',
    'clip it',
    'clip this',
    'clip now',
    'somebody clip that real quick',
    'yo clip that',
  ])('matches %j', transcript => {
    expect(matchesWakePhrase(transcript)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'nothing to see here',
    'paper clip on the table',
    'that was a great clip yesterday',
    'send me the clips',
    'eclipse of the sun',
    'we should clip those videos later',
    'clip art',
    'video clips from yesterday',
    'so what happened',
  ])('does not match %j', transcript => {
    expect(matchesWakePhrase(transcript)).toBe(false);
  });
});
