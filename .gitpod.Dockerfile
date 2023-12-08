FROM gitpod/workspace-full:2023-11-24-15-04-57

RUN bash -c 'VERSION="18" \
    && source $HOME/.nvm/nvm.sh && nvm install $VERSION \
    && nvm use $VERSION && nvm alias default $VERSION'

RUN echo "nvm use default &>/dev/null" >> ~/.bashrc.d/51-nvm-fix
RUN npm install -g aws-cdk
RUN pip install pre-commit==3.5.0
