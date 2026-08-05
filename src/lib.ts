/**
 * Library module for web-hooky
 */

/**
 * Returns a greeting message for the given name.
 *
 * @param name - The name to greet
 * @returns A greeting string
 */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

/**
 * Adds two numbers together.
 *
 * @param a - First number
 * @param b - Second number
 * @returns The sum of a and b
 */
export function add(a: number, b: number): number {
  return a + b;
}
