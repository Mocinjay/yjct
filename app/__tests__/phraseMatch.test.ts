import { matchesWakePhrase } from '../src/wakeword/phraseMatch';

describe('matchesWakePhrase', () => {
  it.each([
    'yo jarvis, clip that',
    'Yo Jarvis clip that!',
    'JARVIS',
    'hey jarvis',
    'okay clip that',
    'clip it',
    'yo jarves clip that', // recognizer mis-hearing
    'jervis clip that',
    'jar vis',
    'and then I said yo jarvis clip that was crazy',
  ])('matches %j', transcript => {
    expect(matchesWakePhrase(transcript)).toBe(true);
  });

  it.each([
    '',
    'nothing to see here',
    'paper clip on the table', // "clip" alone must not fire
    'that was a great clip yesterday',
    'jar of vis', // does not collapse to jarvis
    'we should clip those videos later',
  ])('does not match %j', transcript => {
    expect(matchesWakePhrase(transcript)).toBe(false);
  });
});
