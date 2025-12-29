import { test } from 'vitest';
import assert from 'assert';
import { createUserWithEmailAndPassword } from '../modules/auth/plugins/auth';

test('createUserWithEmailAndPassword should create a user successfully', async () => {
  try {
    const user = await createUserWithEmailAndPassword('testuser@example.com', 'password');
    assert(user);
  } catch (error) {
    assert.fail(error);
  }
});

test('createUserWithEmailAndPassword should throw an error with an invalid email address', async () => {
  try {
    await createUserWithEmailAndPassword('invalidemail', 'password');
    assert.fail('Expected an error to be thrown');
  } catch (error) {
    assert.equal(error.message, 'The email address is badly formatted.');
  }
});

test('createUserWithEmailAndPassword should throw an error with a weak password', async () => {
  try {
    await createUserWithEmailAndPassword('testuser@example.com', '1234');
    assert.fail('Expected an error to be thrown');
  } catch (error) {
    assert.equal(error.message, 'Password should be at least 6 characters');
  }
});

// Additional tests for login, password reset, and logout can be added here
