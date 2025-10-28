Here I am documenting how to run the functional tests for status go. There are not the primary focus of the status-go-codex integration, but they let us to understand the dev env and the build system better in general. I am first presenting the step-by-step instructions to run everything manually from the command line, but because it is quite a lot of details, you may skip ahead to [[#Using development scripts to run the functional tests]] and study the scripts if you want to learn the details.

> I performed all those tests on Arch Linux ([Omarchy](https://omarchy.org/) distribution).

### Step by step instructions to run functional tests manually without a script

First, some helpers regarding namings:

```bash
# identifier
$ git rev-parse --short HEAD
c827909c8
# project_name
$ echo "status-go-func-tests-$(git rev-parse --short HEAD)"
status-go-func-tests-c827909c8
# image_name
$ echo "statusgo-$(git rev-parse --short HEAD)"
statusgo-c827909c8
```

If you do not have the pyenv in place, create one with:

```bash
python3 -m venv "./tests-functional/.venv"
```

and then always make sure it is activated:

```bash
source "./tests-functional/.venv/bin/activate"
```

To check if you are in a venv, you can use:

```bash
$ echo $VIRTUAL_ENV
/home/mc2/code/status-im/status-go/tests-functional/.venv
```

Then make sure the dependencies are in place - you do not need to do this if you did it already and you did not introduce any new python dependencies - it does not harm to do though and it runs instantly:

```bash
pip install --upgrade pip && pip install -r "./tests-functional/requirements.txt"
```

Now, if you did not before, make sure you have built status-go docker image. From status-go repo root folder:

```
docker build . \
  --build-arg "build_tags='gowaku_no_rln'" \
  --build-arg "enable_go_cache=false" \
  --tag "statusgo-$(git rev-parse --short HEAD)"
```

This, image will be used during the tests.

I normally like to make sure I have no old related containers and networks running, before starting a new session:

```bash
docker ps -a --filter "status-go-func-tests-$(git rev-parse --short HEAD)" -q | xargs -r docker rm -f && \
(docker network rm "status-go-func-tests-$(git rev-parse --short HEAD)_default" 2>/dev/null || true)
``` 

Above I make sure, I ignore the error when the network does not exist.

Now, we also need to start foundry, anvil, and the waku node. We do not not need to build custom image for that. Just run docker compose as follows:

```bash
docker compose -p "status-go-func-tests-$(git rev-parse --short HEAD)" \
  -f "./tests-functional/docker-compose.anvil.yml" \
  -f "./tests-functional/docker-compose.waku.yml" \
  up -d --build --remove-orphans
```

or as a one liner:

```bash
docker compose -p "status-go-func-tests-$(git rev-parse --short HEAD)" -f tests-functional/docker-compose.anvil.yml -f tests-functional/docker-compose.waku.yml up -d --build --remove-orphans
```

You will have the following containers running:

![[Pasted image 20250911204521.png]]

Now, with everything in place, we can run the tests:

```bash
pytest --reruns 2 -m rpc -c ./tests-functional/pytest.ini -n 12 \
  --dist loadgroup \
  --log-cli-level=INFO \
  --logs-dir=./tests-functional/logs \
  --docker_project_name="status-go-func-tests-$(git rev-parse --short HEAD)" \
  --docker-image="statusgo-$(git rev-parse --short HEAD)"
```

or if you prefer a one liner:

```bash
pytest --reruns 2 -m rpc -c ./tests-functional/pytest.ini -n 12 --dist=loadgroup --log-cli-level=INFO --logs-dir=./tests-functional/logs --docker_project_name="status-go-func-tests-$(git rev-parse --short HEAD)" --docker-image="statusgo-$(git rev-parse --short HEAD)"
```

After running the tests, make sure you clean up:

```bash
$ docker compose -p "status-go-func-tests-$(git rev-parse --short HEAD)" -f tests-functional/docker-compose.anvil.yml -f tests-functional/docker-compose.waku.yml stop

$ docker compose -p "status-go-func-tests-$(git rev-parse --short HEAD)" -f tests-functional/docker-compose.anvil.yml -f tests-functional/docker-compose.waku.yml down
```

and then make sure nothing is left (the above command will not clean everything if there are some other containers alive that use the resources):

```bash
docker ps -a --filter "status-go-func-tests-$(git rev-parse --short HEAD)" -q | xargs -r docker rm -f && \
(docker network rm "status-go-func-tests-$(git rev-parse --short HEAD)_default" 2>/dev/null || true)
```

To run individual test, we can use the same command with `-k <test-name>` appended.

```bash
pytest --reruns 2 -m rpc -c ./tests-functional/pytest.ini -n 12 \
  --dist=loadgroup \
  --log-cli-level=INFO \
  --logs-dir=./tests-functional/logs \
  --docker_project_name="status-go-func-tests-$(git rev-parse --short HEAD)" \
  --docker-image="statusgo-$(git rev-parse --short HEAD)" \
  -k test_logging
```

Notice, that if you have some simple test that does not need status go container, you can just run something like`pytest -k test_logging`.

### Using development scripts to run the functional tests

To keep things easy and clean, it is easier to use a script. For development I created simplified, more robust version of the original script in `_assets/scripts/run_functional_tests.sh`. First, to get the tests run faster I extracted building of the status-go image into `_assets/scripts/build_status_go_docker.sh`

```bash
$ _assets/scripts/build_status_go_docker.sh
```

> The scripts should be run from the top level directory so that the right docker files are used.

Then I removed the coverage data (not so important in the development), and included explicit waiting for the docker services before running the tests. This way, it is easier to see which tests actually need a "rerun" and which just failed because docker services were not ready yet (which is very much observable with the original script). The name of the new script is `_assets/scripts/run_functional_tests_dev.sh`. The new script takes one optional parameter. This can be either:

- module name
- `Test` class name
- `Test` function name
- and *parameterized* `Test`.

You can easily find those name by looking at the typical Phyton test file:

```python
# File: test_wakuext_messages_transactions.py  ← Module Name

import pytest

class TestTransactionsChatMessages:  # ← Test Class Name
    
    @pytest.mark.parametrize("wakuV2LightClient", [True, False])
    def test_accept_request_address_for_transaction(self, wakuV2LightClient):  # ← Test Function Name
        # Test logic here
        if wakuV2LightClient:
            # Test with wakuV2LightClient_True
        else:
            # Test with wakuV2LightClient_False  ← Parameterized Test
```

or in a more hierarchical view:

```
Module: test_wakuext_messages_transactions.py
├── Class: TestTransactionsChatMessages
│   ├── Function: test_accept_request_address_for_transaction
|   |                                            [wakuV2LightClient_True]
│   └── Function: test_accept_request_address_for_transaction
|   |                                            [wakuV2LightClient_False]
│   └── Function: test_other_function[param1]
│   └── Function: test_other_function[param2]
```

You can target each of those tests by calling and giving as argument:

> I am skipping the prefix in the examples below. The scripts should be run from the top level directory, e.g.: `./_assets/scripts/run_functional_tests_dev.sh ...`

```bash
# Run all tests in the module
run_functional_tests.sh "test_wakuext_messages_transactions"

# Run all tests in the class
run_functional_tests.sh "TestTransactionsChatMessages" 

# Run all variants of this test function
run_functional_tests.sh "test_accept_request_address_for_transaction"

# Run only the False parameter variant
run_functional_tests.sh "test_accept_request_address_for_transaction and wakuV2LightClient_False"

# Run only the True parameter variant  
run_functional_tests.sh "test_accept_request_address_for_transaction and wakuV2LightClient_True"
```

When the argument is provided you the `run_functional_tests.sh` will first tell you which tests will be run and let you decide to continue or not:

```bash
Discovering tests to be run...
Found 14 tests matching: test_wakuext_messages_transactions
Tests to execute:
 1) test_request_transaction[wakuV2LightClient_False]
 2) test_request_transaction[wakuV2LightClient_True]
 3) test_decline_request_transaction[wakuV2LightClient_False]
 4) test_decline_request_transaction[wakuV2LightClient_True]
 5) test_accept_request_transaction[wakuV2LightClient_False]
 6) test_accept_request_transaction[wakuV2LightClient_True]
 7) test_request_address_for_transaction[wakuV2LightClient_False]
 8) test_request_address_for_transaction[wakuV2LightClient_True]
 9) test_decline_request_address_for_transaction[wakuV2LightClient_False]
10) test_decline_request_address_for_transaction[wakuV2LightClient_True]
11) test_accept_request_address_for_transaction[wakuV2LightClient_False]
12) test_accept_request_address_for_transaction[wakuV2LightClient_True]
13) test_send_transaction[wakuV2LightClient_False]
14) test_send_transaction[wakuV2LightClient_True]
Continue with execution? (y/n):
```

When running the script without any arguments, you will be warned that all tests will be run, showing you the expected number of tests and also here you will have an option to stop:

```bash
❯ ./_assets/scripts/run_functional_tests_dev.sh
Using existing virtual environment
Installing dependencies
Discovering tests to be run...
No test pattern provided. This will run all 272 tests!
Continue with execution? (y/n):
```
